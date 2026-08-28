import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

export const name = 'shared-handoff-dsh';
export const PACKAGE_NAME = 'shared-handoff-dsh';

/**
 * Resolve this package's bundled skills root relative to the DSH profile.
 * Mirrors the resolution used in cordis.patch.yml so tests and diagnostics
 * can verify both agree. Works identically on macOS, Linux, and Windows.
 *
 * @param {string | URL} profileBaseUrl - the DSH profile Loader baseUrl.
 * @returns {string} absolute path of the packaged skills directory.
 */
export function resolveSkillRoot(profileBaseUrl) {
	if (!profileBaseUrl) {
		throw new Error('shared-handoff-dsh: missing DSH profile baseUrl for package resolution');
	}
	let manifestPath;
	try {
		manifestPath = createRequire(profileBaseUrl).resolve(`${PACKAGE_NAME}/package.json`);
	} catch (error) {
		throw new Error(
			`shared-handoff-dsh: cannot resolve ${PACKAGE_NAME}/package.json from the DSH profile`,
			{ cause: error },
		);
	}
	return join(dirname(manifestPath), 'skills');
}
