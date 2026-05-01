/**
 * 引导文案与字段元数据。
 *
 * 集中定义所有用户可见文本，让未来 i18n / 调整提示语只需改一个文件。
 * Runner 与 interaction 实现都从这里取——不在编排层散落硬编码字符串。
 */

import type { MissingField } from "@zhixing/providers";

/** 字段格式示例：根据字段路径决定提示用户的输入示范 */
export function getSchemaExample(field: MissingField): string {
  switch (field.path) {
    case "config.llm.main.provider":
      return "示例：siliconflow / deepseek / openai / anthropic（内置预设 ID）";
    case "config.llm.main.model":
      return "示例：deepseek-chat / gpt-4o / Pro/MiniMaxAI/MiniMax-M2.5";
    default:
      // credentials.providers.<id>.apiKey
      return "示例：sk-xxxxxxxxxxxxxxxx（敏感字段，输入不会显示）";
  }
}

/** 该字段是否为敏感字段——决定 interaction 是否屏蔽终端回显 */
export function isSensitiveField(field: MissingField): boolean {
  return field.file === "credentials";
}

/**
 * 引导开始时打印的多行欢迎语。
 *
 * 显式打印两份文件的**绝对路径**——用户后续手动编辑时不用猜路径。
 */
export function buildIntroLines(args: {
  configPath: string;
  credentialsPath: string;
}): string[] {
  return [
    "──────────────────────────────────────────────",
    "  欢迎使用知行（zhixing）",
    "──────────────────────────────────────────────",
    "",
    "首次启动需要配置必要字段，将分别写入两份文件：",
    "",
    `  公开配置：${args.configPath}`,
    `              （主对话 LLM 与模型 ID 等；AI 可读，写需用户确认）`,
    `  凭证文件：${args.credentialsPath}`,
    `              （API Key 等；AI 不可读、不可写）`,
    "",
    "提示：随时按 Ctrl+C 或在任一字段直接回车（空输入）即可取消首次配置。",
    "",
  ];
}

/** 引导成功完成后给出的下一步建议 */
export const NEXT_STEP_HINT = '现在可以试试：zhixing -p "你好"';
