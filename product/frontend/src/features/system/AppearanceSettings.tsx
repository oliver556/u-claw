import { Segmented } from "antd";
import { Monitor, Moon, Sun } from "lucide-react";

import type { ThemePreference } from "../../theme/settings";
import { useAppTheme } from "../../theme/ThemeProvider";

const options = [
  { value: "system", label: <span className="appearance-option"><Monitor />跟随系统</span> },
  { value: "light", label: <span className="appearance-option"><Sun />浅色</span> },
  { value: "dark", label: <span className="appearance-option"><Moon />深色</span> },
];

export function AppearanceSettings() {
  const { preference, resolvedTheme, setPreference } = useAppTheme();
  return <section className="appearance-settings" aria-labelledby="appearance-title">
    <header>
      <h1 id="appearance-title">外观</h1>
      <p>选择 U-Claw 界面主题。跟随系统会在系统外观变化时自动切换。</p>
    </header>
    <div className="appearance-control">
      <div>
        <strong>主题模式</strong>
        <span>当前显示为{resolvedTheme === "dark" ? "深色" : "浅色"}</span>
      </div>
      <Segmented
        aria-label="主题模式"
        block
        options={options}
        value={preference}
        onChange={(value) => setPreference(value as ThemePreference)}
      />
    </div>
  </section>;
}
