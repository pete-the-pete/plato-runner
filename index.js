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

const fastglob = require('fast-glob');
const yargs = require('yargs');
const plato = require("es6-plato");
const fs = require('fs-extra');
const path = require('path');
const _ = require('lodash');
const { type } = require('os');
const platoAssets = `${__dirname}/node_modules/es6-plato/lib/assets/`;

/**
 * https://medium.com/@ali.dev/how-to-use-promise-with-exec-in-node-js-a39c4d7bbf77
 * Executes a shell command and return it as a Promise.
 * @param cmd {string}
 * @return {Promise<string>}
 */
function execShellCommand(cmd) {
  const exec = require('child_process').exec;
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
function writeOwnerReports(output, overallReportsMap) {
  const overviewSource = fs.readFileSync(`${__dirname}/templates/owner-overview.html`).toString();

  // all reports by owner, ex: Favorites, Notes
  overallReportsMap.forEach((ownerReport, owner) => {
    debugger;
    if (owner !== 'summary') {
      // copy the assets
      const ownerOutputPath = `${output}/${owner}`
      fs.copy(platoAssets, `${ownerOutputPath}/assets`);
      // write the template, should be async
      plato.writeFile(`${ownerOutputPath}/index.html`, _.template(overviewSource)({
        ownerReport,
        options: {
          owner,
          flags: { eslint: true },
        }
      }));

      // write the report
      plato.writeReport(`${ownerOutputPath}/report`, ownerReport.get('summary'));
      // update the history
      plato.updateHistoricalOverview(`${ownerOutputPath}/report`, ownerReport.get('summary'), {});
    }
  });
}

function writeOverallReport(output, reports) {
  const overviewSource = fs.readFileSync(`${__dirname}/templates/overall.html`).toString();
  fs.copy(platoAssets, `${output}/assets`);
  // write the template, should be async
  plato.writeFile(`${output}/index.html`, _.template(overviewSource)({
    reports,
    options: {
      flags: { eslint: true },
    }
  }));
  // write the report
  plato.writeReport(`${output}/report`, reports.get('summary'));
  // update the history
  plato.updateHistoricalOverview(`${output}/report`, reports.get('summary'), {});
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

async function inspectModule(module, outputDir, title) {
  const currentDir = path.dirname(module);
  const exclude = 'app|styles|build|.eyeglass_cache';
  let platoArgs = {
    title,
    eslintrc,
    recurse: true,
    noempty: true,
    exclude: title.includes('tests') ?
      new RegExp(`${exclude}|addon|index.js`) :
      new RegExp(`${exclude}|tests`)
  };
  console.log(`Plato.inspect ${currentDir} to ${outputDir}`);
  return new Promise((resolve) => plato.inspect(currentDir, outputDir, platoArgs, (_report) => resolve(_report)));  
}

async function run() {
  // get the modules
  const files = await fastglob([
    ...globs.split(',').map((glob) => glob.trim()),
    '!**/node_modules/**',
    '!**/bower_components/**',
  ]);
  console.log(`Found a total of ${files.length} files from globs...`);
  const modules = files.filter(file => file.includes('package.json'));

  console.log(`Inspecting a total of ${modules.length} modules...`);

  // for each module
  //  - get the name, type, and owner
  //    - run script excluding tests
  //    - run script on tests
  //  - for each module
  //    - show the summary per addon at the module level (a table showing the summary for each)
  //  - for each owner
  //    - show the total summary
  // reportsMap: {
  //  [owner]: { tests: [..reports], addons: [...reports], engines: [...reports]}
  // }
  //

  /**
   * TODO:
   *  - write total overview
   *  - make plato fully async
   *  - make plato-runner fully async
   *  - make them _fast_
   *  - break out display portion of plato
   */
  let processedModules = 0;
  const reportsMap = new Map([
    ['summary', []]
  ]);
  const _inspections = modules.map(async currentModule => {
    var json = JSON.parse(fs.readFileSync(currentModule));
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
      inpsections.push(inspectModule(currentModule, outputDir, title));

      // run the report for the module's tests if they exist
      if (fs.existsSync(path.join(module, 'tests'))) {
        title = `${json.name}-tests`;
        outputDir = path.join(output, moduleOwner, moduleType, title);
        inpsections.push(inspectModule(currentModule, outputDir, title));
      }

      // wait for both
      return Promise.all(inpsections).then(results => {
        results.moduleOwner = moduleOwner;
        results.module = module;
        results.moduleType = moduleType;
        return results;
      });
    } else {
      console.log(path.dirname(currentModule));
    }
  });

  Promise.all(_inspections).then(platoReports => {
    console.log(`Processed ${processedModules} total modules.`);
    // write the module overview data
    for (let ownerReports of platoReports) {
      if (ownerReports) {
        // summary for the module
        // concat the reports for the moduleyType
        // concat the reports for the owner]
        reportsMap.get(ownerReports.moduleOwner).get(ownerReports.moduleType).set(ownerReports.module, plato.getOverviewReport(ownerReports[0]));
        reportsMap.get(ownerReports.moduleOwner).get(ownerReports.moduleType).get('summary').push(...ownerReports[0]);
        reportsMap.get(ownerReports.moduleOwner).get('summary').push(...ownerReports[0]);
        reportsMap.get('summary').push(...ownerReports[0]);
        if (ownerReports.length > 1) {
          reportsMap.get(ownerReports.moduleOwner).get('tests').set(ownerReports.module, plato.getOverviewReport(ownerReports[1]));
          reportsMap.get(ownerReports.moduleOwner).get('tests').get('summary').push(...ownerReports[1]);
          reportsMap.get(ownerReports.moduleOwner).get('summary').push(...ownerReports[1]);
          reportsMap.get('summary').push(...ownerReports[1]);
        }
      }
    }
    return reportsMap;
    // munge the data
  }).then(reportsMap => {
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
  }).then(reportsMap => {
    // write the reports
    writeOwnerReports(output, reportsMap);
    writeOverallReport(output, reportsMap);
    return reportsMap
  }).then(reportsMap => {
    // final output
    console.dir(reportsMap);
  });
}

run();