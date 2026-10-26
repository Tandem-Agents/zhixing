/** 本机执行端身份由设备身份确定；权威日志准备与执行端装配共用同一推导。 */
export function executorIdForDevice(deviceId: string): string {
  return `executor:${deviceId}`;
}
