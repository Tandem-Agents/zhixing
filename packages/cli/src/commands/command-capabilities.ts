import type { CommandVisibility } from '@zhixing/core/typeahead';

/** Shared capability contract; independent of either terminal renderer. */
export const FEATURE_CHROME = 'chrome';
export const chromeOnlyVisibility: CommandVisibility = {
  predicate: context => context.features[FEATURE_CHROME] === true,
};
