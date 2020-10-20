'use strict';


/**
 * Runs plato across a large codebase by chunking the work.
 * Params should drive a lot of it, but the overall idea:
 *  - pass in a glob of directories to run plato against (ex. lib/**)
 *  - optionally label the type (ex. addon) - naw, just make this ember-cli-plato-runner and check the package.json for addon or engine
 *  - optionally check ownership (very limited and opinionated, expects an api as SOT that returns JSON
 *      - tricky to parameterize, maybe just a separate script?
 *      - otherwise will use directory name
 *  - standard plato params (exclude, output)
 *  - script runner chunks the work across the globs, passing in owner and type params to structure the output accordingly
 *      - ex. Team -> Type -> plato report for addon
 * 
 * 
 * Process
 *  - global
 *  - filter for those with package.json
 *  - check type (engine/addon)
 *    - run script excluding tests
 *    - run script on tests
 */

import fastglob from 'fast-glob';
import yargs from 'yargs';
import plato from "es6-plato";
import fs from 'fs-extra';
import path from 'path';
import _ from 'lodash';
import { exec } from 'child_process';
import os from 'os';
import workerpool from 'workerpool';

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const platoAssets = `${__dirname}/node_modules/es6-plato/lib/assets/`;

const pool = workerpool.pool(`${__dirname}/lib/worker.js`, {
  maxWorkers: Math.ceil(os.cpus().length*.75),
  workerType: 'thread',
});

const reportsMap = new Map([
  ['summary', []]
]);

/**
 * https://medium.com/@ali.dev/how-to-use-promise-with-exec-in-node-js-a39c4d7bbf77
 * Executes a shell command and return it as a Promise.
 * @param cmd {string}
 * @return {Promise<string>}
 */
function execShellCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.warn(error);
      }
      console.log(`${cmd}: ${stdout}`);
      resolve(stdout ? stdout : stderr);
    });
  });
}

const { argv } = yargs
  .usage('node index.js')
  .options({
    help: {
      describe: 'Shows the help menu',
    },
    globs: {
      type: 'string',
      describe: 'Comma separated list of globs to run the codemod on',
      required: true
    },
    output: {
      type: 'string',
      describe: 'the directory that contains all the output. Defaults to current directory (".")',
      required: true,
    },
    owners: {
      type: 'string',
      describe: 'path to a script that determines the owner of the given path',
      optional: true,
    },
    eslintrc: {
      type: 'string',
      describe: 'path to estlintrc.js, forwarded to plato',
      required: true,
    }
  })
  .strictCommands();

const { output, globs, eslintrc, owners = '' } = argv;

/**
 * Create a tabular report for all of the tests, addons, and engines under a given owner.
 * The report has the following breakdown:
 *  tests
 *    [module] total LOC, average LOC, average Maintainability
 *    ...
 *  addons
 *    [module] total LOC, average LOC, average Maintainability
 *    ...
 *  engines
 *    [module] total LOC, average LOC, average Maintainability
 *    ...
 * @param {*} reportsMap 
 */
async function writeOwnerReports(output, overallReportsMap) {
  const overviewSource = (await fs.readFile(`${__dirname}/templates/owner-overview.html`)).toString();

  // all reports by owner, ex: Favorites, Notes
  for await (let report of overallReportsMap) {
    let [owner, ownerReport] = report;
    if (owner !== 'summary') {
      // copy the assets
      const ownerOutputPath = `${output}/${owner}`
      // write the template, should be async
      await plato.writeFile(`${ownerOutputPath}/index.html`, _.template(overviewSource)({
        ownerReport,
        options: {
          owner,
          flags: { eslint: true },
        }
      }));

      // write the report
      await plato.writeReport(`${ownerOutputPath}/report`, ownerReport.get('summary'));
      // update the history
      await plato.updateHistoricalOverview(`${ownerOutputPath}/report`, ownerReport.get('summary'), {});
    }
  }
}

async function writeOverallReport(output, reports) {
  const overviewSource = (await fs.readFile(`${__dirname}/templates/overall.html`)).toString();
  // write the template, should be async
  await plato.writeFile(`${output}/index.html`, _.template(overviewSource)({
    reports,
    options: {
      flags: { eslint: true },
    }
  }));
  // write the report
  await plato.writeReport(`${output}/report`, reports.get('summary'));
  // update the history
  await plato.updateHistoricalOverview(`${output}/report`, reports.get('summary'), {});
}

function getModuleType(moduleData) {
  return moduleData?.keywords?.includes('ember-engine') ? 'engines' : 'addons';
}

// if no owners, just use ALL
async function getModuleOwner(module, owners) {
  const moduleOwner = !!owners ? (await execShellCommand(`${owners} ${module}`)).trim() : 'ALL';
  if (moduleOwner.includes('Error')) {
    throw new Error(moduleOwner);
  }
  return moduleOwner;
}

function inspectAndProcessModule(moduleOwner, moduleType, currentModule, eslintrc, title) {
  const module = path.dirname(currentModule);
  const outputDir = path.join(output, moduleOwner, moduleType, title);
  return pool.exec('inspectModule', [currentModule, outputDir, eslintrc, title]).then((report) => {
    reportsMap.get(moduleOwner).get(moduleType).set(module, plato.getOverviewReport(report));
    reportsMap.get(moduleOwner).get(moduleType).get('summary').push(...report);
    reportsMap.get(moduleOwner).get('summary').push(...report);
    reportsMap.get('summary').push(...report);
  });
}

async function run() {
  // write the reports
  await fs.copy(platoAssets, `${output}/assets`);
  // get the modules
  const files = await fastglob([
    ...globs.split(',').map((glob) => glob.trim()),
    '!**/bower_components/**',
    '!**/build/**',
    '!**/dist/**',
    '!**/node_modules/**',
  ]);
  console.log(`Found a total of ${files.length} files from globs...`);
  if (!files.length) {
    throw new Error(`No files found for ${globs}!!!`);
  }
  const modules = files.filter(file => file.includes('package.json'));

  console.log(`Inspecting a total of ${modules.length} modules...`);

  let processedModules = 0;
  const _inspections = [];
  for await (let currentModule of modules) {
    const json = JSON.parse(fs.readFileSync(currentModule));
    if (json?.keywords?.includes('ember-addon')) {
      processedModules++;
      // owner
      let moduleOwner = await getModuleOwner(currentModule, owners);
      moduleOwner = moduleOwner.length ? moduleOwner : 'UNKOWN' 

      if (!reportsMap.has(moduleOwner)) {
        reportsMap.set(moduleOwner, new Map([
          ['addons', new Map([['summary', []]])],
          ['engines', new Map([['summary', []]])],
          ['tests', new Map([['summary', []]])],
          ['summary', []]
        ]));
      }

      const moduleType = getModuleType(json);
      const module = path.dirname(currentModule);

      let inpsections = [];
      let title = json.name ?? module.replace(/[^a-zA-Z0-9]/g, '_');
      let outputDir = path.join(output, moduleOwner, moduleType, title);

      // run the report for the module
      console.log(`Inspecting ${currentModule}`);
      _inspections.push(inspectAndProcessModule(moduleOwner, moduleType, currentModule, eslintrc, title));

      // run the report for the module's tests if they exist
      let testsDir = path.join(path.join(module, 'tests'));
      let testsDirExists =  await fs.stat(testsDir).then(() => true).catch(() => false);
      if (testsDirExists) {
        title = `${title}-tests`;
        outputDir = path.join(output, moduleOwner, moduleType, title);
        console.log(`Inspecting tests for ${currentModule}`);
        _inspections.push(inspectAndProcessModule(moduleOwner, 'tests', currentModule, eslintrc, title));
      }
    } else {
      console.log(path.dirname(currentModule));
    }

  }

  Promise.all(_inspections).then(function _reportsMap() {
    // write the categorical overview data
    reportsMap.forEach((ownerReport, name, _map) => {
      if (name === 'summary') {
        _map.set(name, plato.getOverviewReport(ownerReport));
      } else {
        ownerReport.forEach((typeReport, name, _map) => {
          if (name === 'summary') {
            _map.set(name, plato.getOverviewReport(typeReport));
          } else {
            typeReport.forEach((moduleReport, name, _map) => {
              if (name === 'summary') {
                _map.set(name, plato.getOverviewReport(moduleReport));
              }
            });
          }
        });
      }
    });
    return reportsMap;
  }).then(async function writeTheReports(reportsMap) {
    await writeOwnerReports(output, reportsMap);
    await writeOverallReport(output, reportsMap);
    process.exit();
  });
}

run();