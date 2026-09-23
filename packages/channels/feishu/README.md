# @zhixing/channel-feishu

Feishu channel adapter for Zhixing. It maintains the Feishu connection and projects inbound and outbound messages, including card responses, into Zhixing's channel contracts.

This package builds the pinned, self-contained Channel extension shipped with `@zhixing/cli` for existing Feishu connections. The host runs it in a managed child process through the Channel protocol. Its distribution contains the extension manifest and executable; it exposes no JavaScript library entry or standalone bot product.

Architecture and current capability boundaries: [飞书通道架构](../../../docs/modules/feishu/architecture.md).

End users should install `@zhixing/cli` and follow the [Zhixing user guide](https://github.com/Tandem-Agents/zhixing#readme). Report package issues through [GitHub Issues](https://github.com/Tandem-Agents/zhixing/issues).

Released under the MIT License. The license text is included in the package.
