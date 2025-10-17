#!/usr/bin/env node

/**
 * Rust Debugging MCP Server
 * CodeLLDBを使用してRustプログラムをデバッグするMCPサーバー
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { RustDebugger } from './rust-debugger.js';
import type { LaunchConfig } from './types.js';

// デバッガーインスタンス（セッション管理）
let rustDebugger: RustDebugger | null = null;

// MCPサーバーを作成
const server = new McpServer({
  name: 'rust-debugger',
  version: '1.0.0'
});

// Zodスキーマ定義
const launchArgsShape = {
  program: z.string().describe('デバッグ対象のRustバイナリパス'),
  cwd: z.string().optional().describe('作業ディレクトリ（オプション）')
};
const launchSchema = z.object(launchArgsShape);

const breakpointArgsShape = {
  file: z.string().describe('ソースファイルのパス'),
  line: z.number().describe('行番号')
};
const breakpointSchema = z.object(breakpointArgsShape);

/**
 * debug_launch ツール: デバッグセッションを開始
 */
server.registerTool(
  'debug_launch',
  {
    title: 'Launch Rust Program',
    description: 'Rustプログラムのデバッグセッションを開始します',
    inputSchema: launchArgsShape
  },
  async (rawArgs: unknown) => {
    const args = launchSchema.parse(rawArgs ?? {});

    // 既存のセッションがあれば終了
    if (rustDebugger) {
      await rustDebugger.terminate();
    }

    // 新しいデバッガーインスタンスを作成
    rustDebugger = new RustDebugger();
    const result = await rustDebugger.launch(args as LaunchConfig);

    return {
      content: [
        {
          type: 'text',
          text: result.success
            ? `デバッグセッションを開始しました: ${args.program}`
            : `エラー: ${result.error}`
        }
      ]
    };
  }
);

/**
 * debug_continue ツール: 実行を継続
 */
server.registerTool(
  'debug_continue',
  {
    title: 'Continue Execution',
    description: '実行を継続します',
    inputSchema: {}
  },
  async () => {
    if (!rustDebugger) {
      return {
        content: [{ type: 'text', text: 'エラー: デバッグセッションが開始されていません' }]
      };
    }

    const result = await rustDebugger.continue();
    return {
      content: [
        {
          type: 'text',
          text: result.success ? '実行を継続しました' : `エラー: ${result.error}`
        }
      ]
    };
  }
);

/**
 * debug_step_over ツール: ステップオーバー
 */
server.registerTool(
  'debug_step_over',
  {
    title: 'Step Over',
    description: '次の行へステップ実行します',
    inputSchema: {}
  },
  async () => {
    if (!rustDebugger) {
      return {
        content: [{ type: 'text', text: 'エラー: デバッグセッションが開始されていません' }]
      };
    }

    const result = await rustDebugger.stepOver();
    return {
      content: [
        {
          type: 'text',
          text: result.success ? '次の行へ移動しました' : `エラー: ${result.error}`
        }
      ]
    };
  }
);

/**
 * debug_get_variables ツール: 変数を取得
 */
server.registerTool(
  'debug_get_variables',
  {
    title: 'Get Variables',
    description: '現在のスコープの変数を取得します',
    inputSchema: {}
  },
  async () => {
    if (!rustDebugger) {
      return {
        content: [{ type: 'text', text: 'エラー: デバッグセッションが開始されていません' }]
      };
    }

    const result = await rustDebugger.getVariables();
    if (!result.success) {
      return {
        content: [{ type: 'text', text: `エラー: ${result.error}` }]
      };
    }

    const variables = result.data?.variables ?? [];
    if (variables.length === 0) {
      return {
        content: [{ type: 'text', text: '変数が見つかりませんでした' }]
      };
    }

    const varList = variables.map(v =>
      `${v.name}: ${v.value} (${v.type || 'unknown'})`
    ).join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `変数 (${variables.length}件):\n${varList}`
        }
      ]
    };
  }
);

/**
 * debug_set_breakpoint ツール: ブレークポイントを設定
 */
server.registerTool(
  'debug_set_breakpoint',
  {
    title: 'Set Breakpoint',
    description: 'ブレークポイントを設定します',
    inputSchema: breakpointArgsShape
  },
  async (rawArgs: unknown) => {
    if (!rustDebugger) {
      return {
        content: [{ type: 'text', text: 'エラー: デバッグセッションが開始されていません' }]
      };
    }

    const args = breakpointSchema.parse(rawArgs ?? {});
    const result = await rustDebugger.setBreakpoint(args as { file: string; line: number });

    if (!result.success) {
      return {
        content: [{ type: 'text', text: `エラー: ${result.error}` }]
      };
    }

    const breakpoints = result.data?.breakpoints ?? [];
    const bpList = breakpoints.map(bp =>
      `  ${bp.file}:${bp.line} (${bp.verified ? '設定完了' : '未確認'})`
    ).join('\n');

    return {
      content: [
        {
          type: 'text',
          text: `ブレークポイントを設定しました:\n${bpList}`
        }
      ]
    };
  }
);

/**
 * debug_terminate ツール: デバッグセッションを終了
 */
server.registerTool(
  'debug_terminate',
  {
    title: 'Terminate Debug Session',
    description: 'デバッグセッションを終了します',
    inputSchema: {}
  },
  async () => {
    if (!rustDebugger) {
      return {
        content: [{ type: 'text', text: 'デバッグセッションは開始されていません' }]
      };
    }

    const result = await rustDebugger.terminate();
    rustDebugger = null;

    return {
      content: [
        {
          type: 'text',
          text: result.success ? 'デバッグセッションを終了しました' : `エラー: ${result.error}`
        }
      ]
    };
  }
);

// サーバーを起動
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Rust Debugging MCP Server started');
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
