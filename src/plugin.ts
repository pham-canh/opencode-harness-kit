// The plugin type, without the plugin package.
//
// The kit's plugin functions are typed with opencode's own `Plugin` type,
// and that type lives in `@opencode-ai/plugin` - a package that depends on
// `effect`, `zod` and `@opencode-ai/sdk`, and has three peer dependencies of
// its own.
//
// A consumer that installs the kit to compile a config should not have to
// install all of that. And they do not have to: the published declarations
// imported the plugin's type, so `npm install opencode-harness-kit` gave a
// consumer whose type-check failed with "Cannot find module
// '@opencode-ai/plugin'". The optional peer dependency did not fix it -
// npm never installs an optional peer on its own.
//
// So the type is declared here, structurally: what opencode actually calls.
//
// The real type is still checked, in `plugin-type-check.ts`, against the
// real package - in CI, where the package is installed. A drift between the
// two is a failed build, not a broken consumer.

/**
 * A plugin: a function opencode calls once, which returns the hooks it
 * wants registered.
 *
 * The context and the options are opencode's, and the kit does not name
 * their fields - it uses what it needs and tolerates the rest.
 */
export type Plugin = (
  ctx: any,
  options?: any,
) => Promise<Record<string, any>>

/**
 * The hooks a plugin returns.
 *
 * opencode calls each one by name; the kit registers `config`, `tool.execute.before`
 * and `chat.message`. A hook that is not in this list is not a hook.
 */
export type Hooks = Record<string, (...args: any[]) => any>
