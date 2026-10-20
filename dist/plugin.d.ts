/**
 * A plugin: a function opencode calls once, which returns the hooks it
 * wants registered.
 *
 * The context and the options are opencode's, and the kit does not name
 * their fields - it uses what it needs and tolerates the rest.
 */
export type Plugin = (ctx: any, options?: any) => Promise<Record<string, any>>;
/**
 * The hooks a plugin returns.
 *
 * opencode calls each one by name; the kit registers `config`, `tool.execute.before`
 * and `chat.message`. A hook that is not in this list is not a hook.
 */
export type Hooks = Record<string, (...args: any[]) => any>;
