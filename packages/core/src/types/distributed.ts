/** 分布式运行时合同共用的基础标量。 */
export type Ulid = string;
export type IsoTime = string;
export type Digest = string;
export type KeyConfirmation = string;
export type ProtocolVersion = string;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface Signature {
  alg: string;
  keyId: string;
  sig: string;
}

/** 内容寻址对象的稳定引用；正文和真实路径不进入协议。 */
export interface ArtifactRef {
  digest: Digest;
  bytes: number;
}

/** 所有顶层 wire 合同的当前版本标记。 */
export interface WireContractV1 {
  readonly v: 1;
}

declare const wireSchemaId: unique symbol;

/** 顶层协议 schema 的编译期身份；独立于 wire 版本。 */
export interface WireSchemaIdentity<SchemaId extends string> {
  readonly [wireSchemaId]?: SchemaId;
}

/** 顶层协议 schema 的编译期身份；标记不会进入序列化结果。 */
export interface WireSchemaV1<SchemaId extends string>
  extends WireContractV1, WireSchemaIdentity<SchemaId> {}
