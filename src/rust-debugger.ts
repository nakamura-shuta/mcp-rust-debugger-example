/**
 * Rustデバッガー - CodeLLDB (lldb) を使用したシンプルな実装
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DebugProtocol } from '@vscode/debugprotocol';
import type { LaunchConfig, Variable, ToolResponse, SetBreakpointConfig, BreakpointInfo } from './types.js';

export class RustDebugger extends EventEmitter {
  private codelldbProcess: ChildProcess | null = null;
  private messageBuffer = '';
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private requestSeq = 1;
  private threadId?: number;
  private frameId?: number;

  /**
   * CodeLLDBの場所を自動検出
   */
  private findCodeLLDB(): string | null {
    const homeDir = homedir();

    // VS Code拡張のデフォルトパス候補
    const candidates = [
      // macOS
      '/Applications/Visual Studio Code.app/Contents/Resources/app/extensions/vadimcn.vscode-lldb/adapter/codelldb',
      join(homeDir, 'Library/Application Support/Code/User/globalStorage/vadimcn.vscode-lldb/lldb/extension/adapter/codelldb'),
      join(homeDir, '.vscode/extensions/vadimcn.vscode-lldb-*/adapter/codelldb'),
      // Linux
      join(homeDir, '.vscode/extensions/vadimcn.vscode-lldb-*/adapter/codelldb'),
      // Windows
      join(homeDir, '.vscode\\extensions\\vadimcn.vscode-lldb-*\\adapter\\codelldb.exe'),
      // Homebrew LLVM
      '/opt/homebrew/opt/llvm/bin/lldb-dap',
      '/usr/local/opt/llvm/bin/lldb-dap'
    ];

    for (const path of candidates) {
      if (existsSync(path)) {
        return path;
      }
    }

    return null;
  }

  /**
   * デバッグセッションを開始
   */
  async launch(config: LaunchConfig): Promise<ToolResponse> {
    try {
      // CodeLLDBプロセスを起動
      // 環境変数で指定するか、デフォルトパスを使用
      const codelldbPath = process.env.CODELLDB_PATH ?? this.findCodeLLDB();

      if (!codelldbPath) {
        throw new Error(
          'CodeLLDB が見つかりません。環境変数 CODELLDB_PATH を設定するか、' +
          'VS Code 拡張 "CodeLLDB" をインストールしてください。\n' +
          '例: export CODELLDB_PATH="/path/to/codelldb"'
        );
      }

      this.codelldbProcess = spawn(codelldbPath, [], {
        stdio: ['pipe', 'pipe', 'pipe']
      });

      // 標準出力からDAPメッセージを受信
      this.codelldbProcess.stdout?.on('data', (data: Buffer) => {
        console.error('CodeLLDB stdout:', data.toString());
        this.messageBuffer += data.toString();
        this.parseMessages();
      });

      this.codelldbProcess.stderr?.on('data', (data: Buffer) => {
        console.error('CodeLLDB stderr:', data.toString());
      });

      // プロセス終了監視
      this.codelldbProcess.on('exit', (code, signal) => {
        console.error(`CodeLLDB process exited: code=${code}, signal=${signal}`);
      });

      // 初期化シーケンス
      console.error('[DEBUG] Sending initialize request...');
      await this.sendRequest('initialize', {
        clientID: 'mcp-rust-debugger',
        clientName: 'MCP Rust Debugger',
        adapterID: 'lldb',
        pathFormat: 'path',
        linesStartAt1: true,
        columnsStartAt1: true
      });
      console.error('[DEBUG] Initialize response received');

      // initialized イベントと launch リクエストを同時に処理
      // CodeLLDBは launch リクエストを受信後に initialized イベントを送信する
      console.error('[DEBUG] Setting up initialized event listener...');
      const initializedPromise = new Promise<void>((resolve) => {
        this.once('initialized', () => {
          console.error('[DEBUG] Initialized event received');
          resolve();
        });
      });

      // プログラム起動（レスポンスを待たない）
      console.error('[DEBUG] Sending launch request...');
      const program = config.program.trim();
      const cwd = (config.cwd ?? process.cwd()).trim();

      this.sendRequest('launch', {
        program,
        args: config.args ?? [],
        cwd,
        stopOnEntry: config.stopOnEntry ?? true
      }).catch(err => console.warn('Launch request warning:', err));

      // initialized イベントを待機
      await initializedPromise;

      // stopped イベントリスナーを先に設定
      const stoppedPromise = new Promise<void>((resolve) => {
        const onStopped = (body: DebugProtocol.StoppedEvent['body']) => {
          this.threadId = body.threadId;
          console.error(`[DEBUG] Stopped: threadId=${this.threadId}, reason=${body.reason}`);
          this.off('stopped', onStopped);
          resolve();
        };
        this.on('stopped', onStopped);
      });

      // configurationDone を送信（これによりプログラムが実行開始される）
      console.error('[DEBUG] Sending configurationDone...');
      await this.sendRequest('configurationDone', {});
      console.error('[DEBUG] ConfigurationDone sent, waiting for stopped event...');

      // stopped イベントを待機
      await stoppedPromise;

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 実行を継続
   */
  async continue(): Promise<ToolResponse> {
    if (!this.threadId) {
      return { success: false, error: 'No thread ID' };
    }

    try {
      await this.sendRequest('continue', { threadId: this.threadId });

      // 次のstopped イベントを待機（ブレークポイントヒット時）
      await new Promise<void>((resolve) => {
        this.once('stopped', () => resolve());
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * ステップオーバー（次の行へ）
   */
  async stepOver(): Promise<ToolResponse> {
    if (!this.threadId) {
      return { success: false, error: 'No thread ID' };
    }

    try {
      await this.sendRequest('next', { threadId: this.threadId });

      // 次のstopped イベントを待機
      await new Promise<void>((resolve) => {
        this.once('stopped', () => resolve());
      });

      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 変数を取得
   */
  async getVariables(): Promise<ToolResponse<{ variables: Variable[] }>> {
    if (!this.threadId) {
      return { success: false, error: 'No thread ID' };
    }

    try {
      // スタックトレース取得
      const stackTraceResponse = await this.sendRequest('stackTrace', {
        threadId: this.threadId,
        startFrame: 0,
        levels: 1
      }) as DebugProtocol.StackTraceResponse;

      const frames = stackTraceResponse.body.stackFrames ?? [];
      if (frames.length === 0) {
        return { success: true, data: { variables: [] } };
      }

      this.frameId = frames[0].id;

      // スコープ取得
      const scopesResponse = await this.sendRequest('scopes', {
        frameId: this.frameId
      }) as DebugProtocol.ScopesResponse;

      const scopes = scopesResponse.body.scopes ?? [];
      const allVariables: Variable[] = [];

      // 各スコープの変数を取得
      for (const scope of scopes) {
        if (scope.variablesReference) {
          const vars = await this.getVariablesFromReference(scope.variablesReference);
          allVariables.push(...vars);
        }
      }

      return { success: true, data: { variables: allVariables } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 変数参照から変数を取得
   */
  private async getVariablesFromReference(variablesReference: number): Promise<Variable[]> {
    const response = await this.sendRequest('variables', {
      variablesReference
    }) as DebugProtocol.VariablesResponse;

    const vars = response.body.variables ?? [];
    return vars.map((v: DebugProtocol.Variable) => ({
      name: v.name,
      value: v.value,
      type: v.type,
      variablesReference: v.variablesReference
    }));
  }

  /**
   * デバッグセッションを終了
   */
  async terminate(): Promise<ToolResponse> {
    try {
      if (this.codelldbProcess) {
        await this.sendRequest('disconnect', { terminateDebuggee: true })
          .catch(() => {}); // エラーは無視

        this.codelldbProcess.kill();
        this.codelldbProcess = null;
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * ブレークポイントを設定
   */
  async setBreakpoint(config: SetBreakpointConfig): Promise<ToolResponse<{ breakpoints: BreakpointInfo[] }>> {
    try {
      const response = await this.sendRequest('setBreakpoints', {
        source: { path: config.file },
        breakpoints: [{ line: config.line }]
      }) as DebugProtocol.SetBreakpointsResponse;

      const breakpoints: BreakpointInfo[] = (response.body.breakpoints ?? []).map((bp, index) => ({
        id: bp.id ?? index,
        file: config.file,
        line: bp.line ?? config.line,
        verified: bp.verified ?? false
      }));

      return { success: true, data: { breakpoints } };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * DAPリクエストを送信
   */
  private async sendRequest(command: string, args: unknown): Promise<unknown> {
    const seq = this.requestSeq++;
    const message = {
      type: 'request',
      seq,
      command,
      arguments: args
    };

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(seq, { resolve, reject });

      const content = JSON.stringify(message);
      const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;

      this.codelldbProcess?.stdin?.write(header + content);

      // タイムアウト設定 (30秒)
      setTimeout(() => {
        if (this.pendingRequests.has(seq)) {
          this.pendingRequests.delete(seq);
          reject(new Error(`Request ${command} timed out`));
        }
      }, 30000);
    });
  }

  /**
   * 受信メッセージをパース
   */
  private parseMessages(): void {
    while (true) {
      const headerEnd = this.messageBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.messageBuffer.slice(0, headerEnd);
      const match = /Content-Length: (\d+)/.exec(header);
      if (!match) {
        console.error('Invalid header:', header);
        this.messageBuffer = '';
        break;
      }

      const contentLength = parseInt(match[1], 10);
      const messageStart = headerEnd + 4;
      const messageEnd = messageStart + contentLength;

      if (this.messageBuffer.length < messageEnd) {
        break; // まだメッセージが完全に受信されていない
      }

      const content = this.messageBuffer.slice(messageStart, messageEnd);
      this.messageBuffer = this.messageBuffer.slice(messageEnd);

      try {
        const message = JSON.parse(content);
        this.handleMessage(message);
      } catch (error) {
        console.error('Failed to parse message:', error);
      }
    }
  }

  /**
   * メッセージ処理
   */
  private handleMessage(message: DebugProtocol.ProtocolMessage): void {
    if (message.type === 'response') {
      const response = message as DebugProtocol.Response;
      const pending = this.pendingRequests.get(response.request_seq);
      if (pending) {
        this.pendingRequests.delete(response.request_seq);
        if (response.success) {
          pending.resolve(response);
        } else {
          pending.reject(new Error(response.message || 'Request failed'));
        }
      }
    } else if (message.type === 'event') {
      const event = message as DebugProtocol.Event;
      this.emit(event.event, event.body);
    }
  }
}
