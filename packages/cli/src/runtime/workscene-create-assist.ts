import { isAbsolute } from "node:path";
import {
  buildWorksceneChangeSummary,
  normalizeSceneName,
  normalizeWorkdir,
  probeWorkdir,
  runToolLoop,
  type ToolLoopProgress,
  type ToolLoopSpec,
  type ToolLoopTool,
} from "@zhixing/core";
import type { WorksceneSummary } from "@zhixing/rpc";
import type { SelectionRequest } from "../tui/selection/index.js";

export interface WorksceneCreateAssistScene {
  readonly sceneId: string;
  readonly name: string;
  readonly workdir?: string;
}

export interface WorksceneCreateProposal {
  readonly name: string;
  readonly workdir?: string;
  readonly workdirNotice?: string;
  readonly summary: string;
}

export type WorksceneCreateAssistResult =
  | { readonly kind: "created"; readonly scene: WorksceneSummary }
  | { readonly kind: "cancelled" }
  | { readonly kind: "fallback"; readonly prefill: string; readonly reason: string };

export interface WorksceneCreateAssistDeps {
  readonly listScenes: () => Promise<readonly WorksceneCreateAssistScene[]>;
  readonly complete: (prompt: string, signal?: AbortSignal) => Promise<string>;
  readonly create: (name: string, workdir?: string) => Promise<WorksceneSummary>;
  readonly confirm: (
    proposal: WorksceneCreateProposal,
    signal?: AbortSignal,
  ) => Promise<boolean>;
  readonly askUser: (question: string, signal?: AbortSignal) => Promise<string | null>;
  readonly onProgress?: (message: string, progress: ToolLoopProgress) => void;
}

type AssistFinal =
  | { readonly kind: "created" }
  | { readonly kind: "ask"; readonly question: string }
  | { readonly kind: "cancelled" };

type Exchange =
  | { readonly role: "user"; readonly text: string }
  | { readonly role: "assistant"; readonly text: string };

const MAX_ROUNDS = 5;
const MAX_CLARIFICATIONS = 4;

export async function runWorksceneCreateAssist(
  firstInput: string,
  deps: WorksceneCreateAssistDeps,
  signal?: AbortSignal,
): Promise<WorksceneCreateAssistResult> {
  const prefill = firstInput.trim();
  if (!prefill) return { kind: "cancelled" };
  if (signal?.aborted) return { kind: "cancelled" };

  const scenes = await deps.listScenes();
  const exchanges: Exchange[] = [{ role: "user", text: prefill }];
  let createdScene: WorksceneSummary | null = null;
  let cancelled = false;

  for (let clarificationCount = 0; clarificationCount <= MAX_CLARIFICATIONS; clarificationCount++) {
    if (signal?.aborted) return { kind: "cancelled" };
    const spec = createAssistSpec({
      scenes,
      exchanges,
      getCreatedScene: () => createdScene,
      isCancelled: () => cancelled,
      create: async (input, sig) => {
        if (createdScene) {
          return {
            ok: true,
            alreadyCreated: true,
            scene: createdScene,
            message: `已创建「${createdScene.name}」`,
          };
        }

        const proposal = await prepareCreateProposal(input);
        const confirmed = await deps.confirm(proposal, sig);
        if (!confirmed) {
          cancelled = true;
          return {
            ok: false,
            cancelled: true,
            message: "用户取消了本次创建",
          };
        }

        const scene = await deps.create(proposal.name, proposal.workdir);
        createdScene = scene;
        return {
          ok: true,
          scene,
          ...(scene.workdirWarning ? { workdirWarning: scene.workdirWarning } : {}),
        };
      },
    });

    const result = await runToolLoop(spec, {
      complete: deps.complete,
      ...(deps.onProgress
        ? {
            onProgress: (progress) =>
              deps.onProgress?.(worksceneCreateAssistProgressText(progress), progress),
          }
        : {}),
    }, signal);

    if (createdScene) return { kind: "created", scene: createdScene };
    if (cancelled) return { kind: "cancelled" };

    if (result.kind === "error") {
      if (signal?.aborted || result.reason === "aborted") return { kind: "cancelled" };
      return { kind: "fallback", prefill, reason: result.reason };
    }
    if (result.kind === "exhausted") {
      return { kind: "fallback", prefill, reason: "智能创建没有收敛到可执行方案" };
    }

    if (result.result.kind === "created") {
      return createdScene
        ? { kind: "created", scene: createdScene }
        : { kind: "fallback", prefill, reason: "模型声称已创建，但没有真实创建结果" };
    }
    if (result.result.kind === "cancelled") return { kind: "cancelled" };

    if (clarificationCount === MAX_CLARIFICATIONS) {
      return { kind: "fallback", prefill, reason: "需要澄清的信息过多" };
    }
    exchanges.push({ role: "assistant", text: result.result.question });
    const answer = await deps.askUser(result.result.question, signal);
    const normalizedAnswer = answer?.trim();
    if (!normalizedAnswer) return { kind: "cancelled" };
    exchanges.push({ role: "user", text: normalizedAnswer });
  }

  return { kind: "fallback", prefill, reason: "智能创建没有完成" };
}

export function createWorksceneCreateSelectionRequest(
  proposal: WorksceneCreateProposal,
): SelectionRequest<"create" | "cancel"> {
  return {
    id: "workscene-create-assist",
    title: `创建工作场景「${proposal.name}」？`,
    body: proposal.summary.split("\n"),
    options: [
      {
        value: "create",
        label: "创建",
        description: "按这个名称和目录设置创建工作场景",
        hotkey: "y",
        tone: "primary",
      },
      {
        value: "cancel",
        label: "取消",
        description: "不创建，回到工作场景列表",
        hotkey: "c",
        tone: "muted",
      },
    ],
    initialValue: "create",
    submitLabel: "选择",
    cancelLabel: "取消",
  };
}

export function worksceneCreateAssistProgressText(
  progress: ToolLoopProgress,
): string {
  if (progress.phase === "deciding") return "正在理解新场景需求...";
  if (progress.tool === "workscene_create") {
    const input = progress.input as Record<string, unknown> | undefined;
    const name = typeof input?.name === "string" ? input.name.trim() : "";
    return name ? `正在准备创建「${name}」...` : "正在准备创建工作场景...";
  }
  return "正在处理工作场景创建...";
}

interface CreateAssistSpecOptions {
  readonly scenes: readonly WorksceneCreateAssistScene[];
  readonly exchanges: readonly Exchange[];
  readonly getCreatedScene: () => WorksceneSummary | null;
  readonly isCancelled: () => boolean;
  readonly create: (
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<Record<string, unknown>>;
}

function createAssistSpec(opts: CreateAssistSpecOptions): ToolLoopSpec<AssistFinal> {
  const createTool: ToolLoopTool<Record<string, unknown>, Record<string, unknown>> = {
    name: "workscene_create",
    description:
      "创建一个新的工作场景。信息足够时才调用；name 必填，workdir 可选且必须是本机绝对路径。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "新工作场景名称" },
        workdir: { type: "string", description: "可选，本机绝对路径" },
      },
      required: ["name"],
    },
    run: opts.create,
  };

  return {
    goal: buildGoal(opts.scenes, opts.exchanges),
    tools: [createTool],
    maxRounds: MAX_ROUNDS,
    parseFinal: (payload) =>
      parseFinal(payload, {
        createdScene: opts.getCreatedScene(),
        cancelled: opts.isCancelled(),
      }),
  };
}

function buildGoal(
  scenes: readonly WorksceneCreateAssistScene[],
  exchanges: readonly Exchange[],
): string {
  return [
    "你在帮助用户新建一个工作场景。工作场景用于把一类长期任务、记忆和可选工作目录组织在一起。",
    "目标：理解用户自然语言里的新场景名称和可选工作目录；信息足够时调用 workscene_create；信息不足时只问一个最关键的澄清问题。",
    "不要编造名称或目录。目录只有用户明确给出时才传 workdir；如果用户没有提目录，可以创建无目录场景。",
    "本次 Ctrl+N 只创建一个工作场景；成功创建后不要再创建第二个。",
    "",
    "现有工作场景快照：",
    ...formatSceneSnapshot(scenes),
    "",
    "本次对话：",
    ...exchanges.map((item) => `${item.role === "user" ? "用户" : "你"}：${item.text}`),
    "",
    "最终输出只能是以下三种之一：",
    '{"final":{"kind":"created"}}：仅在 workscene_create 已真实成功后使用。',
    '{"final":{"kind":"ask","question":"你的澄清问题"}}：信息不足以创建时使用。',
    '{"final":{"kind":"cancelled"}}：用户取消或明确不想创建时使用。',
  ].join("\n");
}

function formatSceneSnapshot(
  scenes: readonly WorksceneCreateAssistScene[],
): string[] {
  if (scenes.length === 0) return ["- 暂无"];
  return scenes.map((scene) => {
    const workdir = scene.workdir ? `，目录：${scene.workdir}` : "";
    return `- ${scene.name} (${scene.sceneId})${workdir}`;
  });
}

function parseFinal(
  payload: unknown,
  state: { readonly createdScene: WorksceneSummary | null; readonly cancelled: boolean },
): { ok: true; result: AssistFinal } | { ok: false; reason: string } {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "final 必须是对象，包含 kind 字段。" };
  }
  const rec = payload as Record<string, unknown>;
  if (rec.kind === "created") {
    return state.createdScene
      ? { ok: true, result: { kind: "created" } }
      : { ok: false, reason: "还没有真实调用 workscene_create 成功，不能声称已创建。" };
  }
  if (rec.kind === "cancelled") {
    return { ok: true, result: { kind: "cancelled" } };
  }
  if (rec.kind === "ask") {
    const question = typeof rec.question === "string" ? rec.question.trim() : "";
    if (!question) return { ok: false, reason: "ask 必须提供非空 question。" };
    if (state.createdScene) {
      return { ok: false, reason: "已经创建成功，请用 created 收尾。" };
    }
    if (state.cancelled) {
      return { ok: false, reason: "用户已经取消，请用 cancelled 收尾。" };
    }
    return { ok: true, result: { kind: "ask", question } };
  }
  return { ok: false, reason: "kind 必须是 created、ask 或 cancelled。" };
}

async function prepareCreateProposal(
  input: Record<string, unknown>,
): Promise<WorksceneCreateProposal> {
  const rawName = input.name;
  if (typeof rawName !== "string") {
    throw new Error("请提供工作场景名称");
  }
  const name = normalizeSceneName(rawName);

  const rawWorkdir = input.workdir;
  if (rawWorkdir !== undefined && typeof rawWorkdir !== "string") {
    throw new Error("工作目录必须是字符串；不需要目录时请省略 workdir");
  }

  const workdir =
    rawWorkdir === undefined || rawWorkdir.trim() === ""
      ? undefined
      : normalizeWorkdir(rawWorkdir);
  let workdirNotice: string | undefined;
  if (workdir !== undefined) {
    if (!isAbsolute(workdir)) {
      throw new Error("工作目录必须是绝对路径");
    }
    const probe = await probeWorkdir(workdir);
    switch (probe.kind) {
      case "directory":
        break;
      case "missing":
        workdirNotice = `工作目录当前不存在，下次进入将自动创建：${workdir}`;
        break;
      case "non_directory":
        throw new Error("工作目录已存在但不是目录");
      case "inaccessible":
        throw new Error(`工作目录不可访问(${probe.code})`);
      case "error":
        throw new Error(`工作目录无法确认(${probe.code})`);
    }
  }

  return {
    name,
    ...(workdir !== undefined ? { workdir } : {}),
    ...(workdirNotice ? { workdirNotice } : {}),
    summary: buildWorksceneChangeSummary(
      { action: "add", name, workdir },
      workdirNotice ? { workdirNotice } : {},
    ),
  };
}
