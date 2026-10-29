import { ROLE_NAMES } from '../roles.js';

const roleSet = new Set(ROLE_NAMES);
const COMPARISON = new Set(['===', '!==', '==', '!=']);

function isRoleLiteral(node) {
  return node?.type === 'Literal' && typeof node.value === 'string' && roleSet.has(node.value);
}

function isRoleMember(node) {
  if (node?.type === 'ChainExpression') return isRoleMember(node.expression);
  if (node?.type !== 'MemberExpression') return false;
  const name = node.computed ? node.property.value : node.property.name;
  return name === 'role' || name === 'roles';
}

/** All authorization goes through PolicyService (CLAUDE.md section 5). */
export default {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow role checks outside the policy module' },
    messages: {
      roleCheck:
        'Role checks belong in the policy module. Call PolicyService.can(actor, action, resource) instead.',
    },
    schema: [],
  },
  create(context) {
    return {
      BinaryExpression(node) {
        if (!COMPARISON.has(node.operator)) return;
        if (
          isRoleLiteral(node.left) ||
          isRoleLiteral(node.right) ||
          isRoleMember(node.left) ||
          isRoleMember(node.right)
        ) {
          context.report({ node, messageId: 'roleCheck' });
        }
      },
      SwitchStatement(node) {
        if (isRoleMember(node.discriminant)) context.report({ node, messageId: 'roleCheck' });
      },
      CallExpression(node) {
        // roles.includes('agency_admin'), [..].includes(actor.role)
        const callee =
          node.callee.type === 'ChainExpression' ? node.callee.expression : node.callee;
        if (callee.type !== 'MemberExpression' || callee.property.name !== 'includes') return;
        if (
          isRoleMember(callee.object) ||
          node.arguments.some((a) => isRoleLiteral(a) || isRoleMember(a))
        ) {
          context.report({ node, messageId: 'roleCheck' });
        }
      },
    };
  },
};
