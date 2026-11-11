import { memo } from "react";
import DefaultHeader from "./DefaultHeader.tsx";
import HiddenHeader from "./HiddenHeader.tsx";
import { configStore } from "../store/configStore.ts";
import type { Component } from "../utils/types.ts";

function Header(): Component {
  const { showHeader } = configStore();

  if (showHeader) return <DefaultHeader />;
  return <HiddenHeader />;
}

export default memo(Header);
