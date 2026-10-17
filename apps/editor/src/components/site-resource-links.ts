/**
 * The source of the build that is running. The static (GitHub Pages) build is
 * the smallsignal fork, and AGPL §13 asks that its users be offered that
 * modified source, not upstream's.
 */
export const SITE_REPOSITORY_URL = import.meta.env?.ICM_STATIC_PAGES
  ? "https://github.com/Broyojo/smallsignal"
  : "https://github.com/cascode-ai/analog-canvas";

/** The hosted site's privacy notice; a static build has no such page. */
export const SITE_HAS_PRIVACY_PAGE = !import.meta.env?.ICM_STATIC_PAGES;

export const SITE_CHANGE_LOG_URL = `${SITE_REPOSITORY_URL}/commits/main`;

/** The privacy and cookie notice. */
export const SITE_PRIVACY_PATH = "/privacy";

/** Who runs the site and answers privacy requests. */
export const SITE_OPERATOR = "Token Zhang";
export const SITE_PRIVACY_CONTACT = "zzhishuai@ethz.ch";
