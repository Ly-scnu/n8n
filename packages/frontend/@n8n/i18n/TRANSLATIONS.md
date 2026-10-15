# Community translations

## Simplified Chinese

`src/locales/zh-CN.json` uses the translation dictionary from
[bsi-bcp/n8n-i18n-chinese](https://github.com/bsi-bcp/n8n-i18n-chinese),
commit `a334bac7ee6bdc9c5d9549ff1ac4b1cb15061341`.
The dictionary uses the MIT license. See `licenses/zh-CN-MIT.txt` for the
copyright notice and license terms. The n8n application keeps its own license.

The shared i18n entry registers both `en` and `zh-CN`, including production
builds. Set the instance locale to `zh-CN` to select Simplified Chinese.

The dictionary is filtered to the 9,250 keys in the English locale at
`n8n@2.43.6`. Three entries are adapted to the current English messages:

- `credentials.empty.heading`
- `variables.empty.heading`
- `projects.move.resource.success.message.workflow`

These adaptations remove interpolation variables that the current UI does not
supply. Technical terms and code examples can remain in English. Node-specific
descriptions that use a separate translation mechanism can also remain in English.

When updating n8n, compare locale keys and interpolation variables with the new
English dictionary. Keep the upstream copyright and license notices.
