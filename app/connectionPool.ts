import { Connection } from "@solana/web3.js";

class sequentialSelector<T> {
  private sequence: T[] = [];
  private index: number = 0;

  constructor(seq: T[]) {
    this.sequence = seq;
  }
  public select(idx: number = null) {
    if (this.sequence.length === 0) {
      return null;
    }

    const sequenceIndex = idx || this.index++ % this.sequence.length;
    return {
      element: this.sequence[sequenceIndex],
      index: sequenceIndex,
    };
  }
}

/**
 * Available provider: Alchemy(no wss), ankr, chainstack, infura, quicknode
 *
 */
export class ConnectionPool {
  private httpsConnections: sequentialSelector<Connection>;
  private wssConnections: sequentialSelector<Connection>;

  constructor(connectionPoolParams: {
    wssConnections: Connection[];
    httpsConnections: Connection[];
  }) {
    const { wssConnections, httpsConnections } = connectionPoolParams;
    this.httpsConnections = new sequentialSelector<Connection>(httpsConnections);
    this.wssConnections = new sequentialSelector<Connection>(wssConnections);
  }

  public getHttpsConnection(idx: number = null) {
    return this.httpsConnections.select(idx);
  }

  public getWssConnection(idx: number = null) {
    return this.wssConnections.select(idx);
  }
}
