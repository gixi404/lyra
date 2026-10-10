import { Loader2 } from "lucide-react";
import type { Component } from "../utils/types";

function Loading(): Component {
  return (
    <div className="w-[680px] max-w-full flex items-center justify-center py-12">
      <Loader2 size={24} className="animate-spin text-[#00a8ff]" />
    </div>
  );
}

export default Loading;
