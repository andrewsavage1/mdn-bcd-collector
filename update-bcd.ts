//
// mdn-bcd-collector: update-bcd.ts
// Script to update the BCD data using collected results
//
// See https://github.com/foolip/mdn-bcd-collector/blob/main/DESIGN.md#updating-bcd
// for documentation on the approach taken in this script.
//
// © Google LLC, Gooborg Studios
// See the LICENSE file for copyright details
//

import {
  Browsers,
  SimpleSupportStatement,
  Identifier
} from '@mdn/browser-compat-data/types';
import {
  Report,
  TestResultValue,
  SupportMatrix,
  BrowserSupportMap,
  Overrides,
  InternalSupportStatement
} from './types/types.js';

import path from 'node:path';
import {fileURLToPath} from 'node:url';

import assert from 'assert';
import {
  compare as compareVersions,
  compareVersions as compareVersionsSort
} from 'compare-versions';
import esMain from 'es-main';
import fs from 'fs-extra';
import klaw from 'klaw';
import minimatch from 'minimatch';
const {Minimatch} = minimatch;
import yargs from 'yargs';
import {hideBin} from 'yargs/helpers';

import logger from './logger.js';
import {parseUA} from './ua-parser.js';

const BCD_DIR = fileURLToPath(
  new URL(process.env.BCD_DIR || `../browser-compat-data`, import.meta.url)
);

const {default: mirror} = await import(
  path.join(BCD_DIR, 'scripts', 'release', 'mirror.js')
);

export const findEntry = (
  bcd: Identifier,
  ident: string
): Identifier | null => {
  if (!ident) {
    return null;
  }
  const keys: string[] = ident.split('.');
  let entry: any = bcd;
  while (entry && keys.length) {
    entry = entry[keys.shift() as string];
  }
  return entry;
};

const clone = (value) => JSON.parse(JSON.stringify(value));

const combineResults = (results: TestResultValue[]): TestResultValue => {
  let supported: TestResultValue = null;
  for (const result of results) {
    if (result === true) {
      // If any result is true, the flattened support should be true. There
      // can be contradictory results with multiple exposure scopes, but here
      // we treat support in any scope as support of the feature.
      return true;
    } else if (result === false) {
      // This may yet be overruled by a later result (above).
      supported = false;
    } else if (result === null) {
      // Leave supported as it is.
    } else {
      throw new Error(`result not true/false/null; got ${result}`);
    }
  }
  return supported;
};

// Create a string represenation of a version range, optimized for human
// legibility.
const joinRange = (lower: string, upper: string) =>
  lower === '0' ? `≤${upper}` : `${lower}> ≤${upper}`;

// Parse a version range string produced by `joinRange` into a lower and upper
// boundary.
export const splitRange = (range: string) => {
  const match = range.match(/(?:(.*)> )?(?:≤(.*))/);
  if (!match) {
    throw new Error(`Unrecognized version range value: "${range}"`);
  }
  return {lower: match[1] || '0', upper: match[2]};
};

// Get support map from BCD path to test result (null/true/false) for a single
// report.
export const getSupportMap = (report: Report): BrowserSupportMap => {
  // Transform `report` to map from test name (BCD path) to array of results.
  const testMap = new Map();
  for (const tests of Object.values(report.results)) {
    for (const test of tests) {
      // TODO: If test.exposure.endsWith('Worker'), then map this to a
      // worker_support feature.
      const tests = testMap.get(test.name) || [];
      tests.push(test.result);
      testMap.set(test.name, tests);
    }
  }

  if (testMap.size === 0) {
    throw new Error(`Report for "${report.userAgent}" has no results!`);
  }

  // Transform `testMap` to map from test name (BCD path) to flattened support.
  const supportMap = new Map();
  for (const [name, results] of testMap.entries()) {
    let supported = combineResults(results);

    if (supported === null) {
      // If the parent feature support is false, copy that.
      // TODO: This  assumes that the parent feature came first when iterating
      // the report, which isn't guaranteed. Move this to a second phase.
      const parentName = name.split('.').slice(0, -1).join('.');
      const parentSupport = supportMap.get(parentName);
      if (parentSupport === false) {
        supported = false;
      }
    }

    supportMap.set(name, supported);
  }
  return supportMap;
};

// Load all reports and build a map from BCD path to browser + version
// and test result (null/true/false) for that version.
export const getSupportMatrix = (
  reports: Report[],
  browsers: Browsers,
  overrides: Overrides
): SupportMatrix => {
  const supportMatrix = new Map();

  for (const report of reports) {
    const {browser, version, inBcd} = parseUA(report.userAgent, browsers);
    if (!inBcd) {
      if (inBcd === false) {
        logger.warn(
          `Ignoring unknown ${browser.name} version ${version} (${report.userAgent})`
        );
      } else if (browser.name) {
        logger.warn(
          `Ignoring unknown browser ${browser.name} ${version} (${report.userAgent})`
        );
      } else {
        logger.warn(`Unable to parse browser from UA ${report.userAgent}`);
      }

      continue;
    }

    const supportMap = getSupportMap(report);

    // Merge `supportMap` into `supportMatrix`.
    for (const [name, supported] of supportMap.entries()) {
      let browserMap = supportMatrix.get(name);
      if (!browserMap) {
        browserMap = new Map();
        supportMatrix.set(name, browserMap);
      }
      let versionMap = browserMap.get(browser.id);
      if (!versionMap) {
        versionMap = new Map();
        for (const browserVersion of Object.keys(
          browsers[browser.id].releases
        )) {
          versionMap.set(browserVersion, null);
        }
        browserMap.set(browser.id, versionMap);
      }
      assert(versionMap.has(version), `${browser.id} ${version} missing`);

      // In case of multiple reports for a single version it's possible we
      // already have (non-null) support information. Combine results to deal
      // with this possibility.
      const combined = combineResults([supported, versionMap.get(version)]);
      versionMap.set(version, combined);
    }
  }

  // apply manual overrides
  for (const [path, browser, version, supported] of overrides) {
    const browserMap = supportMatrix.get(path);
    if (!browserMap) {
      continue;
    }
    const versionMap = browserMap.get(browser);
    if (!versionMap) {
      continue;
    }

    if (version === '*') {
      // All versions of a browser
      for (const v of versionMap.keys()) {
        versionMap.set(v, supported);
      }
    } else if (version.includes('-')) {
      // Browser versions between x and y (inclusive)
      const versions = version.split('-');
      for (const v of versionMap.keys()) {
        if (
          compareVersions(versions[0], v, '<=') &&
          compareVersions(versions[1], v, '>=')
        ) {
          versionMap.set(v, supported);
        }
      }
    } else {
      // Single browser versions
      versionMap.set(version, supported);
    }
  }

  return supportMatrix;
};

export const inferSupportStatements = (
  versionMap: BrowserSupportMap
): SimpleSupportStatement[] => {
  const versions = Array.from(versionMap.keys()).sort(compareVersionsSort);

  const statements: SimpleSupportStatement[] = [];
  const lastKnown: {version: string; support: TestResultValue} = {
    version: '0',
    support: null
  };
  let lastWasNull = false;

  for (const version of versions) {
    const supported = versionMap.get(version);
    const lastStatement = statements[statements.length - 1];

    if (supported === true) {
      if (!lastStatement) {
        statements.push({
          version_added:
            lastWasNull || lastKnown.support === false
              ? joinRange(lastKnown.version, version)
              : version
        });
      } else if (!lastStatement.version_added) {
        lastStatement.version_added = lastWasNull
          ? joinRange(lastKnown.version, version)
          : version;
      } else if (lastStatement.version_removed) {
        // added back again
        statements.push({
          version_added: version
        });
      }

      lastKnown.version = version;
      lastKnown.support = true;
      lastWasNull = false;
    } else if (supported === false) {
      if (
        lastStatement &&
        lastStatement.version_added &&
        !lastStatement.version_removed
      ) {
        lastStatement.version_removed = lastWasNull
          ? joinRange(lastKnown.version, version)
          : version;
      } else if (!lastStatement) {
        statements.push({version_added: false});
      }

      lastKnown.version = version;
      lastKnown.support = false;
      lastWasNull = false;
    } else if (supported === null) {
      lastWasNull = true;
      // TODO
    } else {
      throw new Error(`result not true/false/null; got ${supported}`);
    }
  }

  return statements;
};

export const update = (
  bcd: Identifier,
  supportMatrix: SupportMatrix,
  filter: any
): boolean => {
  let modified = false;

  for (const [path, browserMap] of supportMatrix.entries()) {
    if (filter.path && !filter.path.match(path)) {
      continue;
    }

    const entry = findEntry(bcd, path);
    if (!entry || !entry.__compat) {
      continue;
    }

    const support = entry.__compat.support;
    // Stringified then parsed to deep clone the support statements
    const originalSupport = clone(support);

    for (const [browser, versionMap] of browserMap.entries()) {
      if (
        filter.browser &&
        filter.browser.length &&
        !filter.browser.includes(browser)
      ) {
        continue;
      }
      const inferredStatements = inferSupportStatements(versionMap);
      if (inferredStatements.length !== 1) {
        // TODO: handle more complicated scenarios
        logger.warn(
          `${path} skipped for ${browser} due to multiple inferred statements`
        );
        continue;
      }

      const inferredStatement = inferredStatements[0];

      if (
        filter.release &&
        filter.release !== inferredStatement.version_added &&
        filter.release !== inferredStatement.version_removed
      ) {
        continue;
      }

      // Update the support data with a new value.
      const persist = (statements: SimpleSupportStatement[]) => {
        support[browser] = statements.length === 1 ? statements[0] : statements;
        modified = true;
      };

      let allStatements =
        (support[browser] as InternalSupportStatement) === 'mirror'
          ? mirror(browser, originalSupport)
          : // Although non-mirrored support data could be modified in-place,
            // working with a cloned version forces the subsequent code to
            // explicitly assign it back to the originating data structure.
            // This reduces the likelihood of inconsistencies in the handling
            // of mirrored and non-mirrored support data.
            clone(support[browser] || null);

      if (!allStatements) {
        allStatements = [];
      } else if (!Array.isArray(allStatements)) {
        allStatements = [allStatements];
      }

      // Filter to the statements representing the feature being enabled by
      // default under the default name and no flags.
      const defaultStatements = allStatements.filter((statement) => {
        if ('flags' in statement) {
          return false;
        }
        if ('prefix' in statement || 'alternative_name' in statement) {
          // TODO: map the results for aliases to these statements.
          return false;
        }
        return true;
      });

      if (defaultStatements.length === 0) {
        // Prepend |inferredStatement| to |allStatements|, since there were no
        // relevant statements to begin with...
        if (inferredStatement.version_added === false) {
          // ... but not if the new statement just claims no support, since
          // that is implicit in no statement.
          continue;
        }
        // Remove flag data for features which are enabled by default.
        //
        // See https://github.com/mdn/browser-compat-data/pull/16637
        const nonFlagStatements = allStatements.filter(
          (statement) => !('flags' in statement)
        );
        persist([inferredStatement, ...nonFlagStatements]);

        continue;
      }

      if (defaultStatements.length !== 1) {
        // TODO: handle more complicated scenarios
        logger.warn(
          `${path} skipped for ${browser} due to multiple default statements`
        );
        continue;
      }

      const simpleStatement = defaultStatements[0];

      if (simpleStatement.version_removed) {
        // TODO: handle updating existing added+removed entries.
        logger.warn(
          `${path} skipped for ${browser} due to added+removed statement`
        );
        continue;
      }

      let dataIsOlder = false;
      if (
        inferredStatement.version_added === false &&
        typeof simpleStatement.version_added === 'string'
      ) {
        // Make sure not to update BCD if it is set to a version newer than we have in our data

        for (const [version, result] of Array.from(
          versionMap.entries()
        ).reverse()) {
          if (
            result !== null &&
            simpleStatement.version_added !== 'preview' &&
            compareVersions(
              version,
              simpleStatement.version_added.replace('≤', ''),
              '<='
            )
          ) {
            // A version we have data for is the same or newer than the version in BCD
            dataIsOlder = true;
            break;
          }
        }
      }

      if (dataIsOlder) {
        logger.warn(
          `${path} skipped for ${browser} because results are older than BCD`
        );
        continue;
      } else if (
        typeof simpleStatement.version_added === 'string' &&
        typeof inferredStatement.version_added === 'string' &&
        inferredStatement.version_added.includes('≤')
      ) {
        const {lower, upper} = splitRange(inferredStatement.version_added);
        const simpleAdded = simpleStatement.version_added.replace('≤', '');
        if (
          simpleStatement.version_added === 'preview' ||
          compareVersions(simpleAdded, lower, '<=') ||
          compareVersions(simpleAdded, upper, '>')
        ) {
          simpleStatement.version_added = inferredStatement.version_added;
          persist(allStatements);
        }
      } else if (
        !(
          typeof simpleStatement.version_added === 'string' &&
          inferredStatement.version_added === true
        ) &&
        simpleStatement.version_added !== inferredStatement.version_added
      ) {
        // When a "mirrored" statement will be replaced with a statement
        // documenting lack of support, notes describing partial implementation
        // status are no longer relevant.
        if (
          !inferredStatement.version_added &&
          simpleStatement.partial_implementation
        ) {
          persist([{version_added: false}]);

          // Positive test results do not conclusively indicate that a partial
          // implementation has been completed.
        } else if (!simpleStatement.partial_implementation) {
          simpleStatement.version_added = inferredStatement.version_added;
          persist(allStatements);
        }
      }

      if (typeof inferredStatement.version_removed === 'string') {
        simpleStatement.version_removed = inferredStatement.version_removed;
        persist(allStatements);
      }
    }
  }

  return modified;
};

// |paths| can be files or directories. Returns an object mapping
// from (absolute) path to the parsed file content.
/* c8 ignore start */
export const loadJsonFiles = async (
  paths: string[]
): Promise<{[filename: string]: any}> => {
  // Ignores .DS_Store, .git, etc.
  const dotFilter = (item) => {
    const basename = path.basename(item);
    return basename === '.' || basename[0] !== '.';
  };

  const jsonFiles: string[] = [];

  for (const p of paths) {
    await new Promise((resolve, reject) => {
      klaw(p, {filter: dotFilter})
        .on('data', (item) => {
          if (item.path.endsWith('.json')) {
            jsonFiles.push(item.path);
          }
        })
        .on('error', reject)
        .on('end', resolve);
    });
  }

  const entries = await Promise.all(
    jsonFiles.map(async (file) => {
      const data = await fs.readJson(file);
      return [file, data];
    })
  );

  return Object.fromEntries(entries);
};

export const main = async (
  reportPaths: string[],
  filter: any,
  browsers: Browsers,
  overrides: Overrides
): Promise<void> => {
  // Replace filter.path with a minimatch object.
  if (filter.path) {
    filter.path = new Minimatch(filter.path);
  }

  const bcdFiles = (await loadJsonFiles(
    filter.category.map((cat) => path.join(BCD_DIR, ...cat.split('.')))
  )) as {[key: string]: Identifier};

  const reports = Object.values(await loadJsonFiles(reportPaths)) as Report[];
  const supportMatrix = getSupportMatrix(
    reports,
    browsers,
    overrides.filter(Array.isArray)
  );

  // Should match https://github.com/mdn/browser-compat-data/blob/f10bf2cc7d1b001a390e70b7854cab9435ffb443/test/linter/test-style.js#L63
  // TODO: https://github.com/mdn/browser-compat-data/issues/3617
  for (const [file, data] of Object.entries(bcdFiles)) {
    const modified = update(data, supportMatrix, filter);
    if (!modified) {
      continue;
    }
    logger.info(`Updating ${path.relative(BCD_DIR, file)}`);
    const json = JSON.stringify(data, null, '  ') + '\n';
    await fs.writeFile(file, json);
  }
};

if (esMain(import.meta)) {
  const {
    default: {browsers}
  } = await import(`${BCD_DIR}/index.js`);
  const overrides = await fs.readJson(
    new URL('./overrides.json', import.meta.url)
  );

  const {argv}: {argv: any} = yargs(hideBin(process.argv)).command(
    '$0 [reports..]',
    'Update BCD from a specified set of report files',
    (yargs) => {
      yargs
        .positional('reports', {
          describe: 'The report files to update from (also accepts folders)',
          type: 'string',
          array: true,
          default: ['../mdn-bcd-results/']
        })
        .option('category', {
          alias: 'c',
          describe: 'The BCD categories to update',
          type: 'array',
          choices: ['api', 'css.properties', 'javascript.builtins'],
          default: ['api', 'css.properties', 'javascript.builtins']
        })
        .option('path', {
          alias: 'p',
          describe:
            'The BCD path to update (interpreted as a minimatch pattern)',
          type: 'string',
          default: null
        })
        .option('browser', {
          alias: 'b',
          describe: 'The browser to update',
          type: 'array',
          choices: Object.keys(browsers),
          default: []
        })
        .option('release', {
          alias: 'r',
          describe:
            'Only update when version_added or version_removed is set to the given value',
          type: 'string',
          default: null
        });
    }
  );

  await main(argv.reports, argv, browsers, overrides);
}
/* c8 ignore stop */
