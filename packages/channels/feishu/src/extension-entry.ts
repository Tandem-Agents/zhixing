import { serveChannelExtension } from "@zhixing-ai/core/channels/extension-worker";
import { FeishuAdapter } from "./adapter.js";

serveChannelExtension((id) => new FeishuAdapter(id));
