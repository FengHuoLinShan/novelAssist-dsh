// 极简 JSON Schema 子集校验器(R2 自实现, 零依赖)。
// 支持: type(object/string/number/boolean/array)、properties、required、
// additionalProperties(boolean)、items、enum、const、oneOf。
// 错误按 JSON 指针路径归集。
export type ValidatorSchema = {
  type?: "object" | "string" | "number" | "boolean" | "array";
  properties?: Record<string, ValidatorSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ValidatorSchema;
  enum?: unknown[];
  const?: unknown;
  oneOf?: ValidatorSchema[];
};

export interface ValidationIssue {
  path: string; // JSON 指针风格, 如 "/result/threads"
  message: string;
}

export function validateSchema(schema: ValidatorSchema, value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  walk(schema, value, "", issues);
  return issues;
}

function walk(schema: ValidatorSchema, value: unknown, path: string, out: ValidationIssue[]) {
  if (schema.const !== undefined) {
    if (value !== schema.const) {
      out.push({ path, message: `应为常量 ${JSON.stringify(schema.const)}` });
      return;
    }
  }
  if (schema.enum !== undefined) {
    if (!schema.enum.some((e) => e === value)) {
      out.push({ path, message: `不在枚举范围内: ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` });
      return;
    }
  }
  if (schema.oneOf !== undefined) {
    const matches = schema.oneOf.filter((s) => validateSchema(s, value).length === 0);
    if (matches.length !== 1) {
      out.push({ path, message: `oneOf 需恰好命中一个分支, 实际 ${matches.length}` });
      return;
    }
  }
  if (schema.type === undefined) return;

  switch (schema.type) {
    case "object": {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        out.push({ path, message: `应为对象, 实际 ${kind(value)}` });
        return;
      }
      const obj = value as Record<string, unknown>;
      const props = schema.properties ?? {};
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in props)) {
            out.push({ path: joinPath(path, key), message: "additionalProperties=false, 字段不允许" });
          }
        }
      }
      for (const key of Object.keys(props)) {
        if (!(key in obj)) {
          if (schema.required?.includes(key)) {
            out.push({ path: joinPath(path, key), message: "必填字段缺失" });
          }
          continue;
        }
        walk(props[key], obj[key], joinPath(path, key), out);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        out.push({ path, message: `应为数组, 实际 ${kind(value)}` });
        return;
      }
      if (schema.items) {
        value.forEach((item, i) => walk(schema.items!, item, `${path}/${i}`, out));
      }
      return;
    }
    case "string": {
      if (typeof value !== "string") out.push({ path, message: `应为字符串, 实际 ${kind(value)}` });
      return;
    }
    case "number": {
      if (typeof value !== "number") out.push({ path, message: `应为数字, 实际 ${kind(value)}` });
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") out.push({ path, message: `应为布尔, 实际 ${kind(value)}` });
      return;
    }
  }
}

function kind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function joinPath(path: string, key: string): string {
  return `${path}/${key}`;
}
