import path from 'node:path';

/**
 * Enforces the module map in docs/architecture.md section 2 inside packages/server/src.
 * Option: { root: absolute path of packages/server/src, allowed: { module: [modules it may import] } }.
 * Every module may import `core`. Unknown modules are reported so the map stays complete.
 */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Restrict imports between NestJS modules to the architecture module map' },
    messages: {
      forbidden:
        "Module '{{from}}' may not import module '{{to}}' (docs/architecture.md section 2).",
      unknown:
        "Module '{{name}}' is not in the module map. Add it to the module-layers rule options.",
    },
    schema: [
      {
        type: 'object',
        properties: { root: { type: 'string' }, allowed: { type: 'object' } },
        required: ['root', 'allowed'],
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const { root, allowed } = context.options[0];
    const filename = context.filename;
    const relFile = path.relative(root, filename);
    if (relFile.startsWith('..') || path.isAbsolute(relFile)) return {};
    const from = relFile.split(path.sep)[0];
    if (!from || from.includes('.')) return {};

    function check(node, specifier) {
      if (typeof specifier !== 'string') return;
      let target;
      if (specifier.startsWith('.')) {
        target = path.relative(root, path.resolve(path.dirname(filename), specifier));
      } else if (specifier.startsWith('@rent/server/')) {
        target = specifier.slice('@rent/server/'.length);
      } else {
        return;
      }
      if (target.startsWith('..')) return;
      const to = target.split(/[\\/]/)[0];
      if (!to || to === from || to.includes('.')) return;
      if (!(from in allowed)) {
        context.report({ node, messageId: 'unknown', data: { name: from } });
        return;
      }
      if (to === 'core') return;
      if (!(to in allowed)) {
        context.report({ node, messageId: 'unknown', data: { name: to } });
        return;
      }
      if (!allowed[from].includes(to))
        context.report({ node, messageId: 'forbidden', data: { from, to } });
    }

    return {
      ImportDeclaration: (node) => check(node, node.source.value),
      ExportNamedDeclaration: (node) => node.source && check(node, node.source.value),
      ExportAllDeclaration: (node) => check(node, node.source.value),
      ImportExpression: (node) => node.source.type === 'Literal' && check(node, node.source.value),
    };
  },
};
