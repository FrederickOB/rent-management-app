/**
 * Only the ledger's posting service writes journal rows (ADR-003; M4a plan 4.2). This rule fails
 * any code outside packages/server/src/ledger that inserts into journal_entry or journal_line,
 * through Drizzle (`tx.insert(schema.journalLine)`) or in SQL text. The database refuses such a
 * write anyway (only ledger_writer may insert); the rule catches it in CI.
 */
const TABLES = new Set(['journalEntry', 'journalLine']);
const SQL_INSERT = /\binsert\s+into\s+(?:"?public"?\s*\.\s*)?"?journal_(?:entry|line)\b/i;

function tableName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'MemberExpression' && !node.computed) return node.property.name;
  return null;
}

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Only the ledger posting service may insert journal rows' },
    messages: {
      ledgerWrite:
        'Only the ledger posting service writes the journal (packages/server/src/ledger). Post through PostingService.',
    },
    schema: [],
  },
  create(context) {
    const checkText = (node, text) => {
      if (SQL_INSERT.test(text)) context.report({ node, messageId: 'ledgerWrite' });
    };
    return {
      CallExpression(node) {
        const callee =
          node.callee.type === 'ChainExpression' ? node.callee.expression : node.callee;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        if (callee.property.name !== 'insert') return;
        const name = tableName(node.arguments[0]);
        if (name && TABLES.has(name)) context.report({ node, messageId: 'ledgerWrite' });
      },
      Literal(node) {
        if (typeof node.value === 'string') checkText(node, node.value);
      },
      TemplateLiteral(node) {
        checkText(node, node.quasis.map((q) => q.value.raw).join(' '));
      },
    };
  },
};
