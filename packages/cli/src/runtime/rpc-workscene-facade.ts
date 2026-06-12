/**
 * RpcWorksceneFacade —— cli 经 RPC 接入核心宿主的工作场景方法门面。
 *
 * 与 RpcConversationFacade 同模式:方法域封装、不持连接。场景态在宿主侧是
 * 对话的静态属性(无状态机、无 status 方法)——enter 返回场景当前对话的
 * 全域键,接入面据此切自己的当前对话指针;exit 仅 touch,切回 main 是接入面
 * 指针行为。"当前在哪个场景"是连接级 UI 态,宿主与 facade 都零知识。
 */

import type {
  WorksceneEnterResult,
  WorksceneListResult,
  WorksceneSummary,
} from "@zhixing/server";
import type { CoreHostLink } from "./core-host-connection.js";

export class RpcWorksceneFacade {
  constructor(private readonly link: CoreHostLink) {}

  /** 场景候选列表(/work 选择器数据源)。 */
  async list(): Promise<WorksceneSummary[]> {
    const client = await this.link.getClient();
    const result = await client.request<WorksceneListResult>("workscene.list");
    return result.scenes;
  }

  /** 登记新场景;workdir 须为绝对路径(宿主边界校验)。 */
  async create(name: string, workdir?: string): Promise<WorksceneSummary> {
    const client = await this.link.getClient();
    return client.request<WorksceneSummary>("workscene.create", {
      name,
      workdir,
    });
  }

  async rename(sceneId: string, name: string): Promise<WorksceneSummary> {
    const client = await this.link.getClient();
    return client.request<WorksceneSummary>("workscene.rename", {
      sceneId,
      name,
    });
  }

  /** 删除场景登记;场景有活跃会话时宿主拒绝(BUSY)。 */
  async delete(sceneId: string): Promise<void> {
    const client = await this.link.getClient();
    await client.request("workscene.delete", { sceneId });
  }

  /** 取 / 建场景当前对话(宿主原子查询创建),返回全域键 + 场景信息。 */
  async enter(sceneId: string): Promise<WorksceneEnterResult> {
    const client = await this.link.getClient();
    return client.request<WorksceneEnterResult>("workscene.enter", { sceneId });
  }

  /** 退出场景——宿主侧仅 touch(最近使用);切回 main 由调用方自己完成。 */
  async exit(sceneId: string): Promise<void> {
    const client = await this.link.getClient();
    await client.request("workscene.exit", { sceneId });
  }
}
