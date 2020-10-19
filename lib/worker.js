debugger;
import plato from "es6-plato";
import path from 'path';
import workerpool from 'workerpool';

function inspectModule(module, outputDir, eslintrc, title) {
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
  return plato.inspect(currentDir, outputDir, platoArgs);
}

workerpool.worker({
  inspectModule
});