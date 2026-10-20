/**
 * Chain-Registry: Factory für Chain-Watcher + Konfiguration der
 * RPC-Endpunkte aus der Umgebung (Env-Variablen wie in docker-compose.yml).
 *
 *   BTC_RPC_URL / LTC_RPC_URL / ETH_RPC_URL / SOL_RPC_URL / XMR_RPC_URL
 *   optional: <CHAIN>_RPC_USER / <CHAIN>_RPC_PASS für Basic-Auth.
 */
import type { ChainWatcher } from '../services/contracts.js';
import type { Chain } from '../types/index.js';
import type {
  BaseWatcherConfig,
  EthWatcherConfig,
  FetchLike,
  SolWatcherConfig,
  UtxoRpcConfig,
  XmrWatcherConfig,
} from './types.js';
import { BtcWatcher } from './btc.js';
import { LtcWatcher } from './ltc.js';
import { EthWatcher } from './eth.js';
import { SolWatcher } from './sol.js';
import { XmrWatcher } from './xmr.js';

/** Alle unterstützten Chains. */
export const SUPPORTED_CHAINS: Chain[] = ['BTC', 'LTC', 'ETH', 'SOL', 'XMR'];

type EnvLike = Record<string, string | undefined>;

/** Erzeugt einen einzelnen Chain-Watcher per Konfiguration. */
export function createWatcher(
  chain: Chain,
  config: BaseWatcherConfig & Partial<EthWatcherConfig & SolWatcherConfig>
): ChainWatcher {
  switch (chain) {
    case 'BTC':
      return new BtcWatcher(config as UtxoRpcConfig);
    case 'LTC':
      return new LtcWatcher(config as UtxoRpcConfig);
    case 'ETH':
      return new EthWatcher(config as EthWatcherConfig);
    case 'SOL':
      return new SolWatcher(config as SolWatcherConfig);
    case 'XMR':
      return new XmrWatcher(config as XmrWatcherConfig);
    default:
      throw new Error(`Nicht unterstützte Chain: ${chain}`);
  }
}

export class ChainRegistry {
  private readonly watchers = new Map<Chain, ChainWatcher>();

  constructor(watchers?: Iterable<ChainWatcher>) {
    if (watchers) {
      for (const w of watchers) this.register(w);
    }
  }

  /** Registriert (oder überschreibt) einen Watcher. */
  register(watcher: ChainWatcher): void {
    this.watchers.set(watcher.chain, watcher);
  }

  /** Liefert den Watcher für eine Chain — wirft, wenn nicht registriert. */
  get(chain: Chain): ChainWatcher {
    const w = this.watchers.get(chain);
    if (!w) throw new Error(`Kein Chain-Watcher registriert für: ${chain}`);
    return w;
  }

  has(chain: Chain): boolean {
    return this.watchers.has(chain);
  }

  /** Alle registrierten Chains. */
  chains(): Chain[] {
    return [...this.watchers.keys()];
  }

  /**
   * Baut die Registry aus Env-Variablen (BTC_RPC_URL etc.).
   * Wirft mit vollständiger Liste, wenn Endpunkte fehlen.
   */
  static fromEnv(
    env: EnvLike = process.env,
    opts?: { fetchImpl?: FetchLike }
  ): ChainRegistry {
    const missing: string[] = [];
    const registry = new ChainRegistry();

    for (const chain of SUPPORTED_CHAINS) {
      const rpcUrl = env[`${chain}_RPC_URL`];
      if (!rpcUrl) {
        missing.push(`${chain}_RPC_URL`);
        continue;
      }
      const user = env[`${chain}_RPC_USER`];
      const pass = env[`${chain}_RPC_PASS`];
      const config: BaseWatcherConfig = { rpcUrl };
      if (user && pass) config.auth = { user, pass };
      if (opts?.fetchImpl) config.fetchImpl = opts.fetchImpl;
      registry.register(createWatcher(chain, config));
    }

    if (missing.length > 0) {
      throw new Error(`Fehlende RPC-Endpunkte in Env: ${missing.join(', ')}`);
    }
    return registry;
  }
}
