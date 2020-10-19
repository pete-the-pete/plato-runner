import plato from "es6-plato";
import path from 'path';
import workerpool from 'workerpool';

function inspectModule(module, outputDir, eslintrc, title) {
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
  console.log(`Running plato inspect for ${module}`);
  return plato.inspect(`${path.dirname(module)}/**`, outputDir, platoArgs);
}

workerpool.worker({
  inspectModule
});