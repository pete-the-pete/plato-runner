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
      optional: false,
    },
    output: {
      type: 'string',
      describe: 'the directory that contains all the output. Defaults to current directory (".")',
      optional: false,
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
      optional: false,
    }
  })
  .strictCommands();

const { output, globs = '', eslintrc = '', owners = '' } = argv;

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
function writeOwnerReports(output, reportsMap) {
  const overviewSource = fs.readFileSync(`${__dirname}/templates/owner-overview.html`).toString();
  reportsMap.forEach((reports, owner) => {
    // get the overview report for each type (tests, addons, engines)
    let ownerReports = [];
    reports.forEach((report, reportName, reportMap) => {
      let moduleReports = [];
      reportMap.get(reportName).forEach((module, name, map) => {
        // summary per module
        map.get(name).set('summary', plato.getOverviewReport(...module.get('reports')));
        moduleReports = moduleReports.concat(...module.get('reports'));
      });
      // summary per type
      reportMap.get(reportName).set('summary', plato.getOverviewReport(moduleReports));
      ownerReports = ownerReports.concat(moduleReports);
    });
    reports.set('summary', plato.getOverviewReport(ownerReports));
    // copy the assets
    const ownerOutputPath = `${output}/${owner}`
    fs.copy(platoAssets, `${ownerOutputPath}/assets`,  function (err) {
      if (err) return console.error(err)
      console.log('success!');
    });
    // write the template, should be async
    plato.writeFile(`${ownerOutputPath}/index.html`, _.template(overviewSource)({
      reports,
      options: {
        owner,
        flags: { eslint: true },
      }
    }));
    // write the report
    plato.writeReport(`${ownerOutputPath}/report`, reports.get('summary'));
    // update the history
    plato.updateHistoricalOverview(`${ownerOutputPath}/report`, reports.get('summary'), {});
  });
}

function writeOverallReport(output, reportsMap) {
  const overviewSource = fs.readFileSync(`${__dirname}/templates/overall.html`).toString();
  fs.copy(platoAssets, `${output}/assets`,  function (err) {
    if (err) return console.error(err)
    console.log('success!');
  });
  // write the template, should be async
  plato.writeFile(`${output}/index.html`, _.template(overviewSource)({
    reports,
    options: {
      owner,
      flags: { eslint: true },
    }
  }));
  // write the report
  plato.writeReport(`${output}/report`, reports.get('summary'));
  // update the history
  plato.updateHistoricalOverview(`${output}/report`, reports.get('summary'), {});
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
   *  - write to a temporary location then mv to desired output
   *  - write total overview
   *  - make plato fully async
   *  - make plato-runner fully async
   *  - make them _fast_
   *  - break out display portion of plato
   */
  let processedModules = 0;
  let processedAddons = 0;
  let processedEngines = 0;
  const reportsMap = new Map();
  Promise.all(modules.map(async m => {
    var json = JSON.parse(fs.readFileSync(m));
    if (json?.keywords?.includes('ember-addon')) {
      processedModules++;
      // owner
      let moduleOwner = 'ALL';
      if (owners) {
        moduleOwner = (await execShellCommand(`${owners} ${m}`)).trim();
        if (moduleOwner.includes('Error')) {
          throw new Error(moduleOwner);
        }
      }
      if (!reportsMap.has(moduleOwner)) {
        reportsMap.set(moduleOwner, (() => {
          let _map = new Map();
          _map.set('addons', new Map());
          _map.set('engines', new Map());
          _map.set('tests', new Map());
          return _map;
        })());
      }

      // type
      let moduleType;
      if (json?.keywords?.includes('ember-engine')) {
        moduleType = 'engines';
        processedEngines++;
      } else {
        moduleType = 'addons';
        processedAddons++;
      }
      const title = json.name;
      // tests
      const exclude = 'app|styles|build|.eyeglass_cache ';
      let platoArgs = {
        title,
        eslintrc,
        recurse: true,
        noempty: true
      };

      const currentDir = path.dirname(m);
      let testsPlatoRun = Promise.resolve();
      if (fs.existsSync(path.join(currentDir, 'tests'))) {
        const testPlatoArgs = Object.assign({}, platoArgs);
        testPlatoArgs.exclude = new RegExp(`${exclude}|addon|index.js`);
        testPlatoArgs.title = `${testPlatoArgs.title}-tests`;
        const testsOutputDir = path.join((output ? output : process.cwd()), moduleOwner, moduleType, testPlatoArgs.title);
        console.log(`Plato.inspect ${path.dirname(m)} to ${testsOutputDir}`);
        testsPlatoRun = new Promise((resolve) => plato.inspect(path.dirname(m), testsOutputDir, testPlatoArgs, (_report) => resolve(_report))).then(_report => {
          console.log(`capture the report for ${currentDir} tests`);
          if (!reportsMap.get(moduleOwner).get('tests').get(currentDir)) {
            const dataMap = new Map();
            dataMap.set('reports', new Set());
            reportsMap.get(moduleOwner).get('tests').set(currentDir, dataMap);
          }
          reportsMap.get(moduleOwner).get('tests').get(currentDir).get('reports').add(_report);
          return _report;
        });
      }
      const outputDir = path.join((output ? output : process.cwd()), moduleOwner, moduleType, platoArgs.title);
      console.log(`Plato.inspect ${currentDir} to ${outputDir}`);
      platoArgs.exclude = /tests/;

      const addonPlatoRun = new Promise((resolve) => plato.inspect(currentDir, outputDir, platoArgs, (_report) => resolve(_report))).then(_report => {
        console.log(`capture the report for ${currentDir}`);
        if (!reportsMap.get(moduleOwner).get(moduleType).get(currentDir)) {
          const dataMap = new Map();
          dataMap.set('reports', new Set());
          reportsMap.get(moduleOwner).get(moduleType).set(currentDir, dataMap);
        }
        reportsMap.get(moduleOwner).get(moduleType).get(currentDir).get('reports').add(_report);
        return _report;
      })

      // wait for both
      return Promise.all([testsPlatoRun, addonPlatoRun]);
    }
  })).then(() => {
    console.log(`Processed ${processedModules} total modules.`);
    const _output = path.join((output ? output : process.cwd()));
    writeOwnerReports(_output, reportsMap);
    // writeOverallReport(_output, reportsMap);
    console.log(` - ${processedAddons} addons`);
    console.log(` - ${processedEngines} engines`);
    console.dir(reportsMap);
  });
}

run();