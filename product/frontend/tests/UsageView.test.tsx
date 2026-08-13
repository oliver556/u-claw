// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UsageView } from "../src/features/billing/UsageView.js";

afterEach(cleanup);

describe("UsageView", () => {
  it("shows the preview usage metrics and model distribution", () => {
    render(<UsageView />);

    const view = screen.getByRole("region", { name: "积分使用量" });
    expect(within(view).getByRole("heading", { name: "使用量" })).toBeVisible();
    expect(view).toHaveTextContent("当前积分128");
    expect(view).toHaveTextContent("今日消耗14");
    expect(view).toHaveTextContent("近 7 天96");
    expect(view).toHaveTextContent("预计可用9天");
    expect(screen.getByRole("progressbar", { name: "GPT-5.6 Sol 57%" })).toHaveValue(57);
    expect(view).toHaveTextContent("GPT Image 2");
    expect(view).toHaveTextContent("121 积分");
  });

  it("changes the accessible chart when the time range changes", () => {
    render(<UsageView />);

    expect(screen.getAllByRole("img", { name: /8月.*消耗.*积分/ })).toHaveLength(7);
    fireEvent.click(screen.getByRole("button", { name: "14 天" }));
    expect(screen.getAllByRole("img", { name: /8月.*消耗.*积分/ })).toHaveLength(14);
    fireEvent.click(screen.getByRole("button", { name: "30 天" }));
    expect(screen.getAllByRole("img", { name: /8月.*消耗.*积分/ })).toHaveLength(30);
  });

  it("filters usage records by type", () => {
    render(<UsageView />);

    expect(screen.getByText("整理会议纪要")).toBeVisible();
    expect(screen.getByText("生成商品主图")).toBeVisible();
    expect(screen.getByText("搜索工作区文件")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "图片" }));
    expect(screen.queryByText("整理会议纪要")).not.toBeInTheDocument();
    expect(screen.getByText("生成商品主图")).toBeVisible();
    expect(screen.queryByText("搜索工作区文件")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "工具" }));
    expect(screen.getByText("搜索工作区文件")).toBeVisible();
    expect(screen.queryByText("生成商品主图")).not.toBeInTheDocument();
  });
});
