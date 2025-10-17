/**
 * 型定義
 */

export interface LaunchConfig {
  program: string;
  args?: string[];
  cwd?: string;
  stopOnEntry?: boolean;
}

export interface Variable {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
}

export interface ToolResponse<T = void> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SetBreakpointConfig {
  file: string;
  line: number;
}

export interface BreakpointInfo {
  id: number;
  file: string;
  line: number;
  verified: boolean;
}
