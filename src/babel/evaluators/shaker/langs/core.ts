import { types as t } from '@babel/core';

import { IdentifierHandlers, Visitors } from '../types';
import GraphBuilderState from '../GraphBuilderState';
import peek from '../../../utils/peek';
import ScopeManager from '../scope';

function isIdentifier(
  node: t.Node,
  name?: string | string[]
): node is t.Identifier {
  return (
    t.isIdentifier(node) &&
    (name === undefined ||
      (Array.isArray(name) ? name.includes(node.name) : node.name === name))
  );
}

type SideEffect = [
  {
    callee?: (child: t.CallExpression['callee']) => boolean;
    arguments?: (child: t.CallExpression['arguments']) => boolean;
  },
  (node: t.CallExpression, state: GraphBuilderState) => void
];

const sideEffects: SideEffect[] = [
  [
    // if the first argument of forEach is required, mark forEach as required
    {
      callee: node =>
        t.isMemberExpression(node) &&
        t.isIdentifier(node.property) &&
        node.property.name === 'forEach',
    },
    (node, state) => state.graph.addEdge(node.arguments[0], node),
  ],
];

function getCallee(node: t.CallExpression): t.Node {
  if (
    t.isSequenceExpression(node.callee) &&
    node.callee.expressions.length === 2
  ) {
    const [first, second] = node.callee.expressions;
    if (t.isNumericLiteral(first) && first.value === 0) {
      return second;
    }
  }

  return node.callee;
}

/*
 * Returns nodes which are implicitly affected by specified node
 */
function getAffectedNodes(node: t.Node, state: GraphBuilderState): t.Node[] {
  // FIXME: this method should be generalized
  const callee = t.isCallExpression(node) ? getCallee(node) : null;
  if (
    t.isCallExpression(node) &&
    t.isMemberExpression(callee) &&
    isIdentifier(callee.object, 'Object') &&
    isIdentifier(callee.property, [
      'assign',
      'defineProperty',
      'defineProperties',
      'freeze',
      'observe',
    ])
  ) {
    const [obj, property] = node.arguments;
    if (!t.isIdentifier(obj)) {
      return [];
    }

    if (
      state.scope.getDeclaration(obj) !== ScopeManager.globalExportsIdentifier
    ) {
      return [node.arguments[0]];
    }

    if (t.isStringLiteral(property)) {
      if (property.value === '__esModule') {
        return [node.arguments[0]];
      }

      state.graph.addExport(property.value, node);
    }
  }

  return [];
}

export const visitors: Visitors = {
  /*
   * ExpressionStatement
   * This is one of the rare cases when a child defines a dependency on a parent.
   * Suppose we have a code like this:
   * const fn = () => {
   *   let a = 2;
   *   a *= 2;
   *   return a;
   * };
   *
   * `a *= 2` here is an ExpressionStatement node which contains an expression AssignmentExpression `a *= 2`.
   * The result of AssignmentExpression here depends on the fact of ExpressionStatement execution,
   * that's why we need to mark the statement as a dependency of the expression.
   * If we don't mark it, it will be cut as a useless statement.
   */
  ExpressionStatement(this: GraphBuilderState, node: t.ExpressionStatement) {
    this.baseVisit(node);

    this.graph.addEdge(node.expression, node);
  },

  /*
   * FunctionDeclaration | FunctionExpression | ObjectMethod | ArrowFunctionExpression | ClassMethod | ClassPrivateMethod;
   * Functions can be either a statement or an expression.
   * That's why we need to disable default dependency resolving strategy for expressions by passing `ignoreDeps` flag.
   * Every function must have a body. Without a body, it becomes invalid.
   * In general, a body depends on parameters of a function.
   * In real life, some of the parameters can be omitted, but it's not trivial to implement that type of tree shaking.
   */
  Function(this: GraphBuilderState, node: t.Function) {
    const unsubscribe = this.onVisit(descendant =>
      this.graph.addEdge(node, descendant)
    );
    this.baseVisit(node, true); // ignoreDeps=true prevents default dependency resolving
    unsubscribe();

    this.graph.addEdge(node, node.body);
    this.graph.addEdge(node.body, node);

    node.params.forEach(param => this.graph.addEdge(node.body, param));
    if (t.isFunctionDeclaration(node) && node.id !== null) {
      // `id` is an identifier which depends on the function declaration
      this.graph.addEdge(node.id, node);
    }
  },

  /*
   * BlockStatement | Program
   * The same situation as in ExpressionStatement: if one of the expressions is required, the block itself is also required.
   * Whereas a block doesn't depend on its children.
   * Example:
   * 1. let c;
   * 2. { // BlockStatement begin
   * 3.   let a = 1;
   * 4.   let b = 2;
   * 5.   a++;
   * 6.   a = c;
   * 7. } // BlockStatement end
   *
   * If we want to evaluate the value of `c`, we need to evaluate lines 1, 3, 5 and 6,
   * but we don't need line 4, even though it's a child of the block.
   */
  Block(this: GraphBuilderState, node: t.Block) {
    this.baseVisit(node);

    if (t.isProgram(node)) {
      const exportsDeclaration = this.scope.getDeclaration('global:exports')!;
      this.graph.addEdge(node, exportsDeclaration);
      node.directives.forEach(directive => this.graph.addEdge(node, directive));
    }

    node.body.forEach(exp => {
      this.graph.addEdge(exp, node);
    });
  },

  Directive(this: GraphBuilderState, node: t.Directive) {
    this.baseVisit(node);
    this.graph.addEdge(node, node.value);
  },

  /*
   * TryStatement
   * try { /* block *\/ } catch() {/* handler *\/} finalize {/* finalizer *\/}
   * `handler` and `finalizer` do not make sense without `block`
   * `block` depends on the whole node.
   */
  TryStatement(this: GraphBuilderState, node: t.TryStatement) {
    this.baseVisit(node);
    [node.handler, node.finalizer].forEach(statement => {
      if (statement) {
        this.graph.addEdge(node.block, statement);
        this.graph.addEdge(statement, node.block);
      }
    });

    this.graph.addEdge(node.block, node);
  },

  IfStatement(this: GraphBuilderState, node: t.IfStatement) {
    this.baseVisit(node);
    [node.consequent, node.alternate].forEach(statement => {
      if (statement) {
        this.graph.addEdge(statement, node);
      }
    });

    this.graph.addEdge(node, node.consequent);
    this.graph.addEdge(node, node.test);
  },

  /*
   * WhileStatement
   * Pretty simple behaviour here:
   * • if body is required, the statement is required
   * • if the statement is required, the condition is also required.
   */
  WhileStatement(this: GraphBuilderState, node: t.WhileStatement) {
    this.baseVisit(node);
    this.graph.addEdge(node.body, node);
    this.graph.addEdge(node, node.test);
  },

  SwitchCase(this: GraphBuilderState, node: t.SwitchCase) {
    this.baseVisit(node);
    node.consequent.forEach(statement => this.graph.addEdge(statement, node));
    if (node.test) {
      this.graph.addEdge(node, node.test);
    }
  },

  SwitchStatement(this: GraphBuilderState, node: t.SwitchStatement) {
    this.baseVisit(node);
    node.cases.forEach(c => this.graph.addEdge(c, node));
    this.graph.addEdge(node, node.discriminant);
  },

  ForStatement(this: GraphBuilderState, node: t.ForStatement) {
    this.baseVisit(node);

    if (node.body) {
      this.graph.addEdge(node.body, node);
    }

    [node.init, node.test, node.update, node.body].forEach(child => {
      if (child) {
        this.graph.addEdge(node, child);
      }
    });
  },

  /*
   * ForInStatement
   * for (const k in o) { body }
   */
  ForInStatement(this: GraphBuilderState, node: t.ForInStatement) {
    this.baseVisit(node);

    if (node.body) {
      this.graph.addEdge(node.body, node);
      this.graph.addEdge(node, node.body);
      this.graph.addEdge(node.body, node.left);
    }

    this.graph.addEdge(node.left, node.right);
  },

  /*
   * BreakStatement | ContinueStatement | ReturnStatement | ThrowStatement | YieldExpression | AwaitExpression
   * All these nodes are required to evaluate the value of a function in which they are defined.
   * Also, the value of these nodes depends on the argument if it is presented.
   */
  Terminatorless(this: GraphBuilderState, node: t.Terminatorless) {
    this.baseVisit(node);

    if (
      !(t.isBreakStatement(node) || t.isContinueStatement(node)) &&
      node.argument
    ) {
      this.graph.addEdge(node, node.argument);
    }

    const closestFunctionNode = peek(this.fnStack);
    this.graph.addEdge(closestFunctionNode, node);
  },

  /*
   * ObjectExpression
   * Objects are… complicated. Especially because similarly looking code can be either an expression or a pattern.
   * In this case we work with an expression like:
   * const obj = {
   *   method() {}, // ObjectMethod
   *   property: "value", // ObjectProperty
   *   ...rest, // SpreadElement
   * }
   */
  ObjectExpression(this: GraphBuilderState, node: t.ObjectExpression) {
    this.context.push('expression');
    this.baseVisit(node);
    node.properties.forEach(prop => {
      this.graph.addEdge(node, prop);
      if (t.isObjectMethod(prop)) {
        this.graph.addEdge(prop, prop.key);
        this.graph.addEdge(prop, prop.body);
      } else if (t.isObjectProperty(prop)) {
        this.graph.addEdge(prop, prop.key);
        this.graph.addEdge(prop, prop.value);
      } else if (t.isSpreadElement(prop)) {
        this.graph.addEdge(prop, prop.argument);
      }
    });
    this.context.pop();
  },

  /*
   * MemberExpression
   * It's about a simple expression like `obj.foo` or `obj['foo']`.
   * In addition to default behaviour (an expression depends on all its children),
   * we add a backward dependency from an object to a node for processing member
   * expressions in assignments.
   *
   * Example:
   * let obj = { a: 1 };
   * obj.b = 2;
   *
   * If we try to evaluate `obj` without backward dependency,
   * `obj.b = 2` will be cut and we will get just `{ a: 1 }`.
   */
  MemberExpression(this: GraphBuilderState, node: t.MemberExpression) {
    this.baseVisit(node);
    this.graph.addEdge(node.object, node);

    if (t.isIdentifier(node.object) && t.isIdentifier(node.property)) {
      // It's simple `foo.bar` expression. Is it a usage of a required library?
      const declaration = this.scope.getDeclaration(node.object);
      if (declaration && this.graph.importAliases.has(declaration)) {
        // It is. We can remember what exactly we use from it.
        const source = this.graph.importAliases.get(declaration)!;
        this.graph.imports.get(source)!.push(node.property);
      }
    }
  },

  /*
   * AssignmentExpression
   * `a = b`, `{ ...rest } = obj`, `obj.a = 3`, etc.
   * It's not a declaration, it's just an assignment, but it affects
   * the value of declared variable if the variable it mentioned in the left part.
   * So, we apply some context-magic here in order to catch reference of variables in the left part.
   * We switch the context to `lval` and continue traversing through the left branch.
   * If we then meet some identifier, we mark it as a dependency of its declaration.
   */
  AssignmentExpression(this: GraphBuilderState, node: t.AssignmentExpression) {
    this.context.push('lval');
    this.visit<t.AssignmentExpression['left'], t.AssignmentExpression>(
      node.left,
      node,
      'left'
    );
    this.context.pop();

    this.visit(node.right, node, 'right');

    // THe value of an expression depends on the left part.
    this.graph.addEdge(node, node.left);
    // this.graph.addEdge(node, node.right);

    // The left part of an assignment depends on the right part.
    this.graph.addEdge(node.left, node.right);

    // At the same time, the left part doesn't make any sense without the whole expression.
    this.graph.addEdge(node.left, node);
  },

  /*
   * VariableDeclarator
   * It would be pretty simple if it weren't used to declare variables from other modules.
   */
  VariableDeclarator(this: GraphBuilderState, node: t.VariableDeclarator) {
    /*
     * declared is used for detecting external dependencies in cases like
     * const { a, b, c } = require('module');
     *
     * We are remembering all declared variables in order to use it later in CallExpression visitor
     */
    const declared: Array<[t.Identifier, t.Identifier | null]> = [];
    this.meta.set('declared', declared);
    const unregister = this.scope.addDeclareHandler((identifier, from) =>
      declared.push([identifier, from])
    );
    this.baseVisit(node);
    this.meta.delete('declared');
    unregister();

    if (node.init) {
      // If there is an initialization part, the identifier depends on it.
      this.graph.addEdge(node.id, node.init);
    }

    // If we want to evaluate the value of a declared identifier,
    // we need to evaluate the whole expression.
    this.graph.addEdge(node.id, node);

    // If a statement is required itself, an id is also required
    this.graph.addEdge(node, node.id);
  },

  /*
   * VariableDeclaration
   * It's just a wrapper for group of VariableDeclarator.
   * If one of the declarators is required, the wrapper itself is also required.
   */
  VariableDeclaration(this: GraphBuilderState, node: t.VariableDeclaration) {
    this.meta.set('kind-of-declaration', node.kind);
    this.baseVisit(node);
    node.declarations.forEach(declaration =>
      this.graph.addEdge(declaration, node)
    );
    this.meta.delete('kind-of-declaration');
  },

  /*
   * CallExpression
   * Do you remember that we have already mentioned it in VariableDeclarator?
   * It is a simple expression with default behaviour unless it is a `require`.
   *
   * Another tricky use case here is functions with side effects (e.g. `Object.defineProperty`).
   */
  CallExpression(
    this: GraphBuilderState,
    node: t.CallExpression,
    parent: t.Node | null
  ) {
    this.baseVisit(node);

    if (t.isIdentifier(node.callee) && node.callee.name === 'require') {
      // It looks like a module import …
      const scopeId = this.scope.whereIsDeclared(node.callee);
      if (scopeId && scopeId !== 'global') {
        // … but it is just a user defined function
        return;
      }

      const [firstArg] = node.arguments;
      if (!t.isStringLiteral(firstArg)) {
        // dynamic import? Maybe someday we can do something about it
        return;
      }

      const { value: source } = firstArg;
      const declared = this.meta.get('declared') as Array<
        [t.Identifier, t.Identifier | null]
      >;
      if (!declared) {
        // This is a standalone `require`
        return;
      }

      // Define all declared variables as external dependencies.
      declared.forEach(([local, _imported]) =>
        // FIXME: var slugify = require('../slugify').default;
        {
          if (!this.graph.imports.has(source)) {
            this.graph.imports.set(source, []);
          }

          if (
            parent &&
            t.isMemberExpression(parent) &&
            t.isIdentifier(parent.property)
          ) {
            // An imported function is specified right here.
            // eg. require('../slugify').default
            this.graph.imports.get(source)!.push(parent.property);
          } else {
            // The whole namespace was imported. We will know later, what exactly we need.
            // eg. const slugify = require('../slugify');
            this.graph.importAliases.set(local, source);
          }
        }
      );

      return;
    }

    sideEffects.forEach(([conditions, callback]) => {
      if (
        (conditions.callee && !conditions.callee(node.callee)) ||
        (conditions.arguments && !conditions.arguments(node.arguments))
      ) {
        return;
      }

      return callback(node, this);
    });

    getAffectedNodes(node, this).forEach(affectedNode => {
      this.graph.addEdge(affectedNode, node);
      if (t.isIdentifier(affectedNode)) {
        this.graph.addEdge(
          this.scope.getDeclaration(affectedNode)!,
          affectedNode
        );
      }
    });
  },

  /*
   * SequenceExpression
   * It is a special case of expression in which the value of the whole
   * expression depends only on the last subexpression in the list.
   * The rest of the subexpressions can be omitted if they don't have dependent nodes.
   *
   * Example:
   * const a = (1, 2, b = 3, 4, b + 2); // `a` will be equal 5
   */
  SequenceExpression(this: GraphBuilderState, node: t.SequenceExpression) {
    // Sequence value depends on only last expression in the list
    this.baseVisit(node, true);
    if (node.expressions.length > 0) {
      this.graph.addEdge(node, node.expressions[node.expressions.length - 1]);
    }
  },
};

export const identifierHandlers: IdentifierHandlers = {
  declare: [
    ['CatchClause', 'param'],
    ['Function', 'params'],
    ['RestElement', 'argument'],
    ['ThrowStatement', 'argument'],
    ['VariableDeclarator', 'id'],
  ],
  keep: [
    ['FunctionExpression', 'id'],
    ['ObjectProperty', 'key'],
  ],
  refer: [
    ['ArrayExpression', 'elements'],
    ['AssignmentExpression', 'left', 'right'],
    ['BinaryExpression', 'left', 'right'],
    ['CallExpression', 'arguments', 'callee'],
    ['ConditionalExpression', 'test', 'consequent', 'alternate'],
    ['ForInStatement', 'right'],
    ['Function', 'body'],
    ['IfStatement', 'test'],
    ['LogicalExpression', 'left', 'right'],
    ['NewExpression', 'arguments', 'callee'],
    ['ObjectProperty', 'value'],
    ['ReturnStatement', 'argument'],
    ['SequenceExpression', 'expressions'],
    ['SwitchStatement', 'discriminant'],
    ['UnaryExpression', 'argument'],
    ['UpdateExpression', 'argument'],
    ['VariableDeclarator', 'init'],
  ],
};