import { firstReleaseSurface } from "../../app/release-surface";
import { ManagedChannelSettings } from "./ManagedChannelSettings";
import { WechatPersonalConnection } from "./WechatPersonalConnection";

const managedChannelKinds = firstReleaseSurface.channelKinds.filter(
  (kind) => kind !== "wechat-personal",
);

export function ChannelSettings() {
  return <section className="secondary-view channel-settings">
    <header className="channel-page-header">
      <div><h1>渠道连接</h1><p>OpenClaw 消息渠道配置与运行状态</p></div>
    </header>
    <div className="secondary-content channel-content">
      <WechatPersonalConnection />
      {managedChannelKinds.length > 0 ? <ManagedChannelSettings /> : null}
    </div>
  </section>;
}
