/**
 * 进入提醒的访问边界。「↑ 更早的消息」只在一次访问里、用户尚未操作时出现；用户发起的第一个输入
 * （按键、粘贴、鼠标按下、滚轮）即收起，本次访问不再出现。会话页与 F2 只读历史各记一次访问，
 * 只保留当前这一次，不按会话 ID 长期缓存。
 */
export interface ReadingVisit {
  /** 访问所属的会话；启动壳等尚无 ID 的页面为空 */
  readonly id?: string;
  /** 本次访问里用户是否已经发起过输入 */
  readonly operated: boolean;
}

/**
 * 会话页收到视图时的访问：
 * - 视图没有会话 ID（启动壳、对话已删除的提示页）时，访问不变；
 * - 访问还没有 ID、视图带来第一个真实 ID 时，沿用这次访问（启动时已提前输入的用户不会被重新提醒）；
 * - 换成另一个会话时开始新访问；同一会话的重发、换代、重建、重新选中都还是同一次访问。
 */
export function conversationVisit(visit: ReadingVisit, id: string | undefined): ReadingVisit {
  if (!id || visit.id === id) return visit;
  return visit.id ? { id, operated: false } : { id, operated: visit.operated };
}

/**
 * F2 只读历史页收到视图时的访问：真正离开历史页后再进入（entering），或换选了另一个会话，都开始新访问；
 * 历史页上的临时选择层取消或原地选回同一会话不算离开。选择历史时的按键属于选择页，不消耗历史页的提醒。
 */
export function historyVisit(visit: ReadingVisit, id: string | undefined, entering: boolean): ReadingVisit {
  if (!entering && (!id || visit.id === id)) return visit;
  return { id, operated: false };
}

/** 记录一次用户输入：只作用于发生输入时的那次访问，之后被新访问取代的不受影响 */
export function operatedVisit(current: ReadingVisit, origin: ReadingVisit): ReadingVisit {
  if (current.operated || (origin.id && current.id !== origin.id)) return current;
  return { ...current, operated: true };
}
