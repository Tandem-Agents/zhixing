/**
 * 环境变量净化守卫
 *
 * 在工具执行前清理可能被用于二进制劫持的环境变量。
 * 这是执行守卫的一部分，全平台行为一致。
 *
 * 防护的威胁：
 * - LD_PRELOAD / DYLD_INSERT_LIBRARIES 注入恶意库到子进程
 * - LD_LIBRARY_PATH 劫持动态链接库搜索路径
 * - 其他可用于进程注入的环境变量
 */

import type {
  SecurityMiddleware,
  SecurityMiddlewareContext,
  SecurityMiddlewareResult,
} from "./types.js";

/**
 * 必须清除的环境变量——这些变量可被用于向子进程注入恶意代码。
 * 与策略引擎的 bi-env-injection 规则互为纵深防御。
 */
const DANGEROUS_ENV_VARS = [
  // Linux 动态链接器注入
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  // macOS 动态链接器注入
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "DYLD_FRAMEWORK_PATH",
  // 调试器注入
  "DEBUGINFOD_URLS",
  // Node.js 特有的注入向量
  "NODE_OPTIONS",
  "NODE_PATH",
] as const;

/**
 * 有条件清除的环境变量——仅在工具没有显式声明需要时清除。
 * 这些变量有合法用途，但也可能被滥用。
 */
const CONDITIONAL_ENV_VARS = [
  "PYTHONPATH",
  "RUBYLIB",
  "PERL5LIB",
  "CLASSPATH",
] as const;

export class EnvSanitize implements SecurityMiddleware {
  readonly name = "EnvSanitize";
  readonly phase = "guard" as const;
  readonly order = 10;

  async execute(
    ctx: SecurityMiddlewareContext,
    next: () => Promise<SecurityMiddlewareResult>,
  ): Promise<SecurityMiddlewareResult> {
    const removedVars: string[] = [];
    const sanitizedEnv: Record<string, string | undefined> = {};

    for (const varName of DANGEROUS_ENV_VARS) {
      if (process.env[varName] !== undefined) {
        sanitizedEnv[varName] = undefined;
        removedVars.push(varName);
      }
    }

    for (const varName of CONDITIONAL_ENV_VARS) {
      if (process.env[varName] !== undefined) {
        sanitizedEnv[varName] = undefined;
        removedVars.push(varName);
      }
    }

    ctx.state.sanitizedEnv = sanitizedEnv;
    ctx.state.removedEnvVars = removedVars;

    const result = await next();

    if (removedVars.length > 0) {
      return {
        ...result,
        sanitizedEnv,
      };
    }

    return result;
  }

  /**
   * 构建净化后的环境变量对象，供 child_process.spawn 使用。
   * 将危险变量从当前进程环境中移除。
   */
  static buildCleanEnv(
    currentEnv: NodeJS.ProcessEnv = process.env,
  ): Record<string, string> {
    const clean: Record<string, string> = {};
    const allDangerous = new Set<string>([
      ...DANGEROUS_ENV_VARS,
      ...CONDITIONAL_ENV_VARS,
    ]);

    for (const [key, value] of Object.entries(currentEnv)) {
      if (value !== undefined && !allDangerous.has(key)) {
        clean[key] = value;
      }
    }

    return clean;
  }

  /** 检查给定的环境变量名是否在危险列表中 */
  static isDangerous(varName: string): boolean {
    return (DANGEROUS_ENV_VARS as readonly string[]).includes(varName);
  }

  /** 检查给定的环境变量名是否在条件清除列表中 */
  static isConditionallyDangerous(varName: string): boolean {
    return (CONDITIONAL_ENV_VARS as readonly string[]).includes(varName);
  }

  /** 获取所有危险环境变量名列表 */
  static getDangerousVarNames(): readonly string[] {
    return DANGEROUS_ENV_VARS;
  }
}
