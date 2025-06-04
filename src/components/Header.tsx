import DefaultHeader from "./DefaultHeader";
import HiddenHeader from "./HiddenHeader";
import { configStore } from "../store/configStore";
import type { Component } from "../utils/types";

function Header(): Component {
  const { showHeader } = configStore();

  if (showHeader) return <DefaultHeader />;
  return <HiddenHeader />;
}

export default Header;
