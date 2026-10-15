import { createTeamProject, testDb, testModules } from '@n8n/backend-test-utils';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import { randomUUID } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';

import { Agent } from '@/modules/agents/entities/agent.entity';
import { AgentBackgroundJob } from '@/modules/agents/entities/agent-background-job.entity';
import { AgentExecutionThread } from '@/modules/agents/entities/agent-execution-thread.entity';
import { AgentPlan } from '@/modules/agents/entities/agent-plan.entity';
import type { AgentPlanDocument, AgentPlanTask } from '@/modules/agents/plans/agent-plan.schema';
import { AgentBackgroundJobRepository } from '@/modules/agents/repositories/agent-background-job.repository';
import { AgentPlanRepository } from '@/modules/agents/repositories/agent-plan.repository';
import { AgentPlanWorkRepository } from '@/modules/agents/repositories/agent-plan-work.repository';
import { AgentTaskCancellationRepository } from '@/modules/agents/repositories/agent-task-cancellation.repository';

const task = (title: string): AgentPlanTask => ({
	id: randomUUID(),
	kind: 'task',
	title,
	description: title,
	status: 'pending',
	dependsOn: [],
	startedAt: null,
	endedAt: null,
});

describe('Plan task ownership and continuation', () => {
	let db: DataSource;
	let work: AgentPlanWorkRepository;
	let jobs: AgentBackgroundJobRepository;
	let stops: AgentTaskCancellationRepository;
	let thread: AgentExecutionThread;
	let agentId: string;
	let projectId: string;
	let planId: string;
	let tasks: AgentPlanTask[];

	beforeAll(async () => {
		await testModules.loadModules(['agents']);
		await testDb.init();
		db = Container.get(DataSource);
		work = Container.get(AgentPlanWorkRepository);
		jobs = Container.get(AgentBackgroundJobRepository);
		stops = Container.get(AgentTaskCancellationRepository);
		({ id: projectId } = await createTeamProject());
		agentId = randomUUID();
		await db.getRepository(Agent).save({
			id: agentId,
			projectId,
			name: 'Plan tests',
			integrations: [],
			tools: {},
			skills: {},
		});
	});
	beforeEach(async () => {
		thread = await db
			.getRepository(AgentExecutionThread)
			.save({ id: randomUUID(), agentId, projectId, agentName: 'Plan tests' });
		tasks = [task('Help Scout'), task('Crisp'), task('Freshdesk')];
		planId = randomUUID();
		await Container.get(AgentPlanRepository).createActivePlan(
			{
				id: planId,
				threadId: thread.id,
				formatVersion: 1,
				data: { title: 'Research', description: 'Compare products', items: tasks },
			},
			{},
		);
	});
	afterAll(async () => await testDb.terminate());

	async function stop() {
		return await stops.saveStop(
			{
				threadId: thread.id,
				planId,
				requestedAt: new Date().toISOString(),
				stoppedTaskIds: tasks.map((item) => item.id),
				generation: await stops.captureGeneration(thread.id, {}),
				failures: [],
				pause: {
					id: uuidv7(),
					reportedAt: new Date().toISOString(),
					resumedAt: new Date().toISOString(),
				},
			},
			{},
		);
	}
	async function job(taskId: string, pauseRequestId?: string, parentThreadId = thread.id) {
		return await db.getRepository(AgentBackgroundJob).save({
			id: randomUUID(),
			planId,
			planTaskId: taskId,
			parentAgentId: agentId,
			parentThreadId,
			parentResourceId: 'draft-chat:test',
			parentPrincipalHash: 'principal',
			title: 'Research',
			kind: 'subagent',
			subAgentId: agentId,
			childThreadId: randomUUID(),
			status: pauseRequestId ? 'paused' : 'running',
			pauseRequestId: pauseRequestId ?? null,
			notifiedAt: pauseRequestId ? new Date() : null,
		});
	}

	it('requires a valid leaf task and rejects stale and foreign references', async () => {
		await expect(work.validateTask(thread.id, undefined)).rejects.toThrow('pass planTask');
		await expect(
			work.validateTask('another-chat', { planId, planTaskId: tasks[0].id }),
		).rejects.toThrow('another conversation');
		await expect(
			work.validateTask(thread.id, { planId: randomUUID(), planTaskId: tasks[0].id }),
		).rejects.toThrow('stale');
		await expect(
			work.validateTask(thread.id, { planId, planTaskId: randomUUID() }),
		).rejects.toThrow('leaf task');
		await expect(
			work.validateTask(thread.id, { planId, planTaskId: tasks[0].id }),
		).resolves.toBeUndefined();
	});

	it('saves ownership before dispatch and preserves it when the plan is deleted', async () => {
		const id = randomUUID();
		await jobs.insertSubAgentJobIfCapacity(
			{
				id,
				kind: 'subagent',
				parentAgentId: agentId,
				parentThreadId: thread.id,
				parentResourceId: 'draft-chat:test',
				parentPrincipalHash: 'principal',
				title: 'Research',
				subAgentId: agentId,
				childThreadId: randomUUID(),
				timeoutAt: new Date(),
				validatePlanTask: true,
				planTask: { planId, planTaskId: tasks[0].id },
			},
			5,
		);
		expect(await jobs.findById(id)).toMatchObject({ planId, planTaskId: tasks[0].id });
		await jobs.settleIfActive(id, { status: 'completed', result: 'Saved result' });
		await db.getRepository(AgentPlan).delete(planId);
		expect(await jobs.findById(id)).toMatchObject({
			planId: null,
			planTaskId: tasks[0].id,
			result: 'Saved result',
		});
	});

	it('runs Groove without releasing the original stopped tasks', async () => {
		const savedStop = await stop();
		const groove = task('Groove');
		const data: AgentPlanDocument = {
			title: 'Research',
			description: 'Compare products',
			items: [...tasks, groove],
		};
		await Container.get(AgentPlanRepository).replacePlan(
			{ threadId: thread.id, planId, expectedRevision: 1, formatVersion: 1, data },
			{},
		);
		await expect(
			work.validateTask(thread.id, { planId, planTaskId: groove.id }),
		).resolves.toBeUndefined();
		await expect(work.validateTask(thread.id, { planId, planTaskId: tasks[0].id })).rejects.toThrow(
			'stopped',
		);
		expect((await stops.latest(thread.id))?.stoppedTaskIds).toEqual(savedStop.stoppedTaskIds);
	});

	it('reserves only Crisp and leaves its row stopped until admission succeeds', async () => {
		const savedStop = await stop();
		const first = await job(tasks[0].id, savedStop.pause.id);
		const crisp = await job(tasks[1].id, savedStop.pause.id);
		const selected = await work.selectStoppedTasks(thread.id, planId, [tasks[1].id]);
		expect(selected.status).toBe('selected');
		if (selected.status !== 'selected') throw new Error('Selection failed');
		expect(selected.jobs.map((item) => item.id)).toEqual([crisp.id]);
		const timeout = new Date(Date.now() + 60_000);
		expect(await jobs.reservePlanJobs(thread.id, savedStop.pause.id, [crisp.id], timeout, 5)).toBe(
			'reserved',
		);
		await work.releaseStoppedTasks(thread.id, planId, savedStop.pause.id, [tasks[1].id]);
		expect((await stops.latest(thread.id))?.stoppedTaskIds).toContain(tasks[1].id);
		expect(
			await jobs.resumeIfPaused(crisp.id, savedStop.pause.id, 'running', timeout, timeout),
		).toBe(true);
		await work.releaseStoppedTasks(thread.id, planId, savedStop.pause.id, [tasks[1].id]);
		expect((await stops.latest(thread.id))?.stoppedTaskIds).toEqual([tasks[0].id, tasks[2].id]);
		expect((await jobs.findById(first.id))?.status).toBe('paused');
		expect(await jobs.reservePlanJobs(thread.id, savedStop.pause.id, [crisp.id], timeout, 5)).toBe(
			'changed',
		);
	});

	it('keeps old paused plan jobs after another Stop', async () => {
		const firstStop = await stop();
		const first = await job(tasks[0].id, firstStop.pause.id);
		const secondStop = await stop();
		await job(tasks[1].id, secondStop.pause.id);
		expect(
			await jobs.retainLatestStopGroup(agentId, thread.id, 'draft-chat:test', 'Replaced'),
		).toEqual([]);
		expect((await jobs.findById(first.id))?.status).toBe('paused');
		const selected = await work.selectStoppedTasks(thread.id, planId);
		expect(selected.status === 'selected' && selected.jobs).toHaveLength(2);
	});

	it('releases pending tasks without starting jobs and keeps blocked tasks stopped', async () => {
		tasks[1].dependsOn = [tasks[0].id];
		await db.getRepository(AgentPlan).update(planId, {
			data: { title: 'Research', description: 'Compare products', items: tasks },
		});
		const savedStop = await stop();
		const selected = await work.selectStoppedTasks(thread.id, planId, [tasks[0].id, tasks[1].id]);
		if (selected.status !== 'selected') throw new Error('Selection failed');
		expect(selected.blocked).toEqual([{ id: tasks[1].id, blockedBy: [tasks[0].id] }]);
		await work.releaseStoppedTasks(thread.id, planId, savedStop.pause.id, selected.taskIds);
		expect((await stops.latest(thread.id))?.stoppedTaskIds).toEqual([tasks[1].id, tasks[2].id]);
	});

	it('keeps a cancelled workflow task stopped until a replacement job starts', async () => {
		const saved = await stop();
		const workflowJob = await job(tasks[0].id, saved.pause.id);
		await db
			.getRepository(AgentBackgroundJob)
			.update(workflowJob.id, { kind: 'workflow', status: 'cancelled' });
		await work.releaseStoppedTasks(thread.id, planId, saved.pause.id, [tasks[0].id]);
		expect((await stops.latest(thread.id))?.stoppedTaskIds).toContain(tasks[0].id);
		const ref = { planId, planTaskId: tasks[0].id };
		await jobs.insertSubAgentJobIfCapacity(
			{
				id: randomUUID(),
				kind: 'subagent',
				parentAgentId: agentId,
				parentThreadId: thread.id,
				parentResourceId: 'draft-chat:test',
				parentPrincipalHash: 'principal',
				title: 'Restart workflow',
				subAgentId: agentId,
				childThreadId: randomUUID(),
				timeoutAt: new Date(),
				validatePlanTask: true,
				planTask: ref,
			},
			5,
		);
		expect((await stops.latest(thread.id))?.stoppedTaskIds).not.toContain(tasks[0].id);
		const repeated = await work.selectStoppedTasks(thread.id, planId, [tasks[0].id]);
		expect(repeated.status === 'selected' && repeated.jobs).toEqual([]);
	});

	it('checks capacity for the selection and rejects a reservation after a new Stop', async () => {
		const savedStop = await stop();
		const first = await job(tasks[0].id, savedStop.pause.id);
		const crisp = await job(tasks[1].id, savedStop.pause.id);
		await job(tasks[2].id);
		const timeout = new Date(Date.now() + 60_000);
		expect(
			await jobs.reservePlanJobs(thread.id, savedStop.pause.id, [first.id, crisp.id], timeout, 2),
		).toBe('limit-reached');
		expect((await jobs.findById(first.id))?.status).toBe('paused');
		expect(await jobs.reservePlanJobs(thread.id, savedStop.pause.id, [crisp.id], timeout, 2)).toBe(
			'reserved',
		);
		await stop();
		expect(await jobs.reservePlanJobs(thread.id, savedStop.pause.id, [first.id], timeout, 5)).toBe(
			'changed',
		);
		await work.releaseStoppedTasks(thread.id, planId, savedStop.pause.id, [tasks[0].id]);
		expect((await stops.latest(thread.id))?.stoppedTaskIds).toContain(tasks[0].id);
	});

	it('reconstructs legacy stopped IDs from history before Groove was added', async () => {
		const saved = await stop();
		delete saved.stoppedTaskIds;
		await stops.saveStop(saved, {});
		const groove = task('Groove');
		await Container.get(AgentPlanRepository).replacePlan(
			{
				threadId: thread.id,
				planId,
				expectedRevision: 1,
				formatVersion: 1,
				data: { title: 'Research', description: 'Compare products', items: [...tasks, groove] },
			},
			{},
		);
		expect((await work.stopForPlan(thread.id, planId))?.stoppedTaskIds).toEqual(
			tasks.map((item) => item.id),
		);
	});

	it('includes linked descendants and refuses selective continuation for unlinked jobs', async () => {
		const savedStop = await stop();
		const child = await db.getRepository(AgentExecutionThread).save({
			id: randomUUID(),
			parentThreadId: thread.id,
			agentId,
			projectId,
			agentName: 'Child',
		});
		await job(tasks[1].id, savedStop.pause.id, child.id);
		await expect(
			work.validateTask(child.id, { planId, planTaskId: tasks[1].id }, {}, true),
		).resolves.toBeUndefined();
		const selected = await work.selectStoppedTasks(thread.id, planId, [tasks[1].id]);
		expect(selected.status === 'selected' && selected.jobs).toHaveLength(1);
		const legacy = await job(tasks[0].id, savedStop.pause.id);
		await db
			.getRepository(AgentBackgroundJob)
			.update(legacy.id, { planId: null, planTaskId: null });
		await stop();
		expect(await work.selectStoppedTasks(thread.id, planId, [tasks[1].id])).toEqual({
			status: 'task-selection-unavailable',
		});
	});
});
