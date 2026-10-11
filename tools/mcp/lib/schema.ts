import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { ROOT, SRC, rel } from './paths.ts';

export type ValueKind = 'number' | 'string' | 'boolean' | 'array' | 'object' | 'null' | 'any';

export interface FieldSchema {
  name: string;
  type: string;
  kinds: ValueKind[];
  optional: boolean;
  doc?: string;
}

export interface ComponentSchema {
  /** Clave usada en prefabs/escenas (p.ej. "capsule_collider"). */
  key: string;
  className: string;
  file: string;
  /** Tipo del parámetro de load() (o del cast dentro de load), si se pudo resolver. */
  dataType?: string;
  /** true si el tipo admite claves arbitrarias o no se pudo resolver: no avisar de campos desconocidos. */
  open: boolean;
  fields: FieldSchema[];
  /** Componentes que llevan esta clave en la lista `update` de components.json. */
  inUpdateList: boolean;
}

const LOADER = path.join(SRC, 'core', 'loaders', 'Loader.ts');

let cache: { stamp: number; schemas: ComponentSchema[] } | null = null;

/** Mayor mtime de los .ts de src: invalida la caché si se edita cualquier fichero. */
function srcStamp(): number {
  let max = 0;
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.ts')) max = Math.max(max, fs.statSync(p).mtimeMs);
    }
  };
  walk(SRC);
  return max;
}

export function getComponentSchemas(): ComponentSchema[] {
  const stamp = srcStamp();
  if (cache && cache.stamp === stamp) return cache.schemas;
  const schemas = buildSchemas();
  cache = { stamp, schemas };
  return schemas;
}

function loadUpdateList(): Set<string> {
  try {
    const json = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'public', 'data', 'components.json'), 'utf-8'),
    );
    return new Set<string>(json.update ?? []);
  } catch {
    return new Set();
  }
}

function buildSchemas(): ComponentSchema[] {
  const configPath = path.join(ROOT, 'tsconfig.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
  const program = ts.createProgram({
    rootNames: [LOADER],
    options: { ...parsed.options, noEmit: true },
  });
  const checker = program.getTypeChecker();
  const loaderSf = program.getSourceFile(LOADER);
  if (!loaderSf) throw new Error('Loader.ts not found');

  const updateList = loadUpdateList();
  const entries = findFactoryCases(loaderSf);
  const schemas: ComponentSchema[] = [];

  for (const { key, classIdentifier } of entries) {
    const symbol = resolveAlias(checker, checker.getSymbolAtLocation(classIdentifier));
    const classDecl = symbol?.declarations?.find(ts.isClassDeclaration);
    const schema: ComponentSchema = {
      key,
      className: classIdentifier.text,
      file: classDecl ? rel(classDecl.getSourceFile().fileName) : '?',
      open: true,
      fields: [],
      inUpdateList: updateList.has(key),
    };
    if (classDecl && symbol) {
      try {
        fillFromLoad(checker, symbol, schema);
      } catch (e) {
        schema.dataType = `(error resolving: ${(e as Error).message})`;
      }
    }
    schemas.push(schema);
  }
  return schemas.sort((a, b) => a.key.localeCompare(b.key));
}

function resolveAlias(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  if (symbol && symbol.flags & ts.SymbolFlags.Alias) return checker.getAliasedSymbol(symbol);
  return symbol;
}

/** Busca `case 'key': return new Clase();` dentro de createComponentFromJSON. */
function findFactoryCases(sf: ts.SourceFile): { key: string; classIdentifier: ts.Identifier }[] {
  const out: { key: string; classIdentifier: ts.Identifier }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isMethodDeclaration(node) && node.name.getText(sf) === 'createComponentFromJSON') {
      node.forEachChild(function walk(n) {
        if (ts.isCaseClause(n) && ts.isStringLiteral(n.expression)) {
          const key = n.expression.text;
          // Puede haber varios `case` seguidos compartiendo el mismo return.
          let clause: ts.CaseClause | undefined = n;
          const parent = n.parent;
          let idx = parent.clauses.indexOf(n);
          while (clause && clause.statements.length === 0) {
            idx++;
            const next = parent.clauses[idx];
            clause = next && ts.isCaseClause(next) ? next : undefined;
          }
          const ret = clause?.statements.find(ts.isReturnStatement);
          if (
            ret?.expression &&
            ts.isNewExpression(ret.expression) &&
            ts.isIdentifier(ret.expression.expression)
          ) {
            out.push({ key, classIdentifier: ret.expression.expression });
          }
        }
        n.forEachChild(walk);
      });
    }
    node.forEachChild(visit);
  };
  visit(sf);
  return out;
}

function fillFromLoad(
  checker: ts.TypeChecker,
  classSymbol: ts.Symbol,
  schema: ComponentSchema,
): void {
  const classType = checker.getDeclaredTypeOfSymbol(classSymbol);
  const loadSym = classType.getProperty('load');
  const loadDecl = loadSym?.declarations?.find(
    (d): d is ts.MethodDeclaration => ts.isMethodDeclaration(d) && d.body !== undefined,
  );
  if (!loadDecl) return;

  const param = loadDecl.parameters[0];
  const dataTypes: ts.Type[] = [];
  if (param) {
    const t = checker.getTypeAtLocation(param);
    if (!(t.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any))) dataTypes.push(t);
  }

  // `load(data: unknown)` suele hacer `data as XData` o delegar en un método: buscar casts del parámetro.
  const paramName = param && ts.isIdentifier(param.name) ? param.name.text : null;
  const accessed = new Set<string>();
  if (paramName && loadDecl.body) {
    const scan = (n: ts.Node) => {
      if (
        ts.isAsExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === paramName
      ) {
        const t = checker.getTypeFromTypeNode(n.type);
        if (!(t.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any))) dataTypes.push(t);
      }
      if (
        ts.isPropertyAccessExpression(n) &&
        ts.isIdentifier(n.expression) &&
        n.expression.text === paramName
      ) {
        accessed.add(n.name.text);
      }
      n.forEachChild(scan);
    };
    scan(loadDecl.body);
  }

  const fields = new Map<string, FieldSchema>();
  let open = dataTypes.length === 0;
  for (const t of dataTypes) {
    const apparent = checker.getApparentType(t);
    if (apparent.getStringIndexType() || isPrimitiveLike(apparent)) open = true;
    for (const prop of checker.getPropertiesOfType(apparent)) {
      if (fields.has(prop.name)) continue;
      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      const propType = decl ? checker.getTypeOfSymbolAtLocation(prop, decl) : checker.getAnyType();
      const doc = ts.displayPartsToString(prop.getDocumentationComment(checker)).trim();
      const field: FieldSchema = {
        name: prop.name,
        type: checker.typeToString(propType, undefined, ts.TypeFormatFlags.NoTruncation),
        kinds: kindsOf(checker, propType),
        optional: (prop.flags & ts.SymbolFlags.Optional) !== 0,
      };
      if (doc) field.doc = doc;
      fields.set(prop.name, field);
    }
  }
  // Campos leídos como `data.x` que no estén tipados.
  for (const name of accessed) {
    if (!fields.has(name))
      fields.set(name, { name, type: 'unknown', kinds: ['any'], optional: true });
  }

  schema.dataType = dataTypes.map((t) => checker.typeToString(t)).join(' & ') || undefined;
  if (!schema.dataType) delete schema.dataType;
  schema.open = open;
  schema.fields = [...fields.values()];
}

function isPrimitiveLike(t: ts.Type): boolean {
  return (
    (t.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) !== 0
  );
}

function kindsOf(checker: ts.TypeChecker, type: ts.Type): ValueKind[] {
  const kinds = new Set<ValueKind>();
  const types = type.isUnion() ? type.types : [type];
  for (const t of types) {
    const f = t.flags;
    if (f & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) kinds.add('any');
    else if (f & ts.TypeFlags.NumberLike) kinds.add('number');
    else if (f & ts.TypeFlags.StringLike) kinds.add('string');
    else if (f & ts.TypeFlags.BooleanLike) kinds.add('boolean');
    else if (f & ts.TypeFlags.Null) kinds.add('null');
    else if (f & ts.TypeFlags.Undefined) continue;
    else if (checker.isArrayType(t) || checker.isTupleType(t) || isArrayLikeClass(checker, t))
      kinds.add('array');
    else if (f & ts.TypeFlags.Object) kinds.add('object');
    else kinds.add('any');
  }
  return [...kinds];
}

/** vec3/Float32Array/etc. se escriben como arrays en JSON. */
function isArrayLikeClass(checker: ts.TypeChecker, t: ts.Type): boolean {
  const name = t.getSymbol()?.getName() ?? '';
  if (
    /^(Float32Array|Float64Array|Int32Array|Uint32Array|Uint16Array|Uint8Array|ReadonlyArray)$/.test(
      name,
    )
  )
    return true;
  const alias = checker.typeToString(t);
  return /^(vec[234]|quat|mat[34]|ReadonlyVec[234])$/.test(alias);
}

export function formatSchema(s: ComponentSchema, verbose: boolean): string {
  const head = `${s.key}  →  ${s.className} (${s.file})${s.dataType ? `  data: ${s.dataType}` : ''}${s.inUpdateList ? '' : '  [not in components.json update list]'}`;
  if (!verbose) return head;
  if (!s.fields.length)
    return `${head}\n    (no typed fields${s.open ? ', accepts any data' : ''})`;
  const lines = s.fields.map(
    (f) =>
      `    ${f.name}${f.optional ? '?' : ''}: ${f.type}${f.doc ? `  // ${f.doc.replace(/\s+/g, ' ')}` : ''}`,
  );
  if (s.open) lines.push('    (open: extra keys allowed)');
  return `${head}\n${lines.join('\n')}`;
}
