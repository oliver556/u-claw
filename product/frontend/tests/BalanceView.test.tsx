// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BalanceView } from "../src/features/billing/BalanceView.js";

afterEach(() => cleanup());

describe("BalanceView", () => {
  it("shows the balance summary and transaction fields", () => {
    render(<BalanceView />);

    const view = screen.getByRole("region", { name: "余额与积分" });
    expect(within(view).getByRole("heading", { name: "余额" })).toBeVisible();
    expect(within(view).getByText("查看积分余额与收支明细")).toBeVisible();
    expect(within(view).getByLabelText("当前积分")).toHaveTextContent("128");
    expect(within(view).getByLabelText("累计充值")).toHaveTextContent("560");
    expect(within(view).getByLabelText("累计消耗")).toHaveTextContent("432");
    expect(within(view).getByRole("columnheader", { name: "时间" })).toBeVisible();
    expect(within(view).getByRole("columnheader", { name: "积分变动" })).toBeVisible();
  });

  it("filters transaction rows by type", () => {
    render(<BalanceView />);

    fireEvent.click(screen.getByRole("button", { name: "充值", pressed: false }));
    expect(screen.getByRole("button", { name: "充值", pressed: true })).toBeVisible();
    expect(screen.getByText("微信支付充值")).toBeVisible();
    expect(screen.queryByText("GPT-5.6 Sol 对话")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "消耗", pressed: false }));
    expect(screen.getByText("GPT-5.6 Sol 对话")).toBeVisible();
    expect(screen.queryByText("微信支付充值")).not.toBeInTheDocument();
  });

  it("calls the recharge action", () => {
    const onRecharge = vi.fn();
    render(<BalanceView onRecharge={onRecharge} />);

    fireEvent.click(screen.getByRole("button", { name: "充值积分" }));
    expect(onRecharge).toHaveBeenCalledOnce();
  });
});
