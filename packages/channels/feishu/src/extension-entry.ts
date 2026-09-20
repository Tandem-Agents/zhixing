import { serveChannelExtension } from "@zhixing/core/channels/extension-worker";
import { FeishuAdapter } from "./adapter.js";

serveChannelExtension((id) => new FeishuAdapter(id));
