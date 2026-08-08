export type { AuthPromptOptions, SmugMugOptions } from './SmugMug.js'
// `renderAuthPrompt` is exported so an embedder can supply `renderAuthForm`
// without taking its own Preact dependency — two Preact copies in one Dashboard
// render loop crash on hooks.
export { default, renderAuthPrompt } from './SmugMug.js'
