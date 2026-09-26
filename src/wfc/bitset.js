/**
 * bitset.js - fixed-size bit domain over Uint32Array.
 *
 * WFC cell domains are bitsets over the tile dictionary; AC-3 propagation is
 * pure bitwise ops so the solver never touches V8's GC between passes.
 */
'use strict';

class BitSet {
	constructor(size) {
		this.size = size;
		this.words = new Uint32Array((size + 31) >>> 5);
	}
	static full(size) {
		const b = new BitSet(size);
		b.words.fill(0xFFFFFFFF);
		const rem = size & 31;
		if (rem) b.words[b.words.length - 1] = (1 << rem) - 1;
		return b;
	}
	clone() {
		const b = new BitSet(this.size);
		b.words.set(this.words);
		return b;
	}
	set(i) { this.words[i >>> 5] |= 1 << (i & 31); }
	clear(i) { this.words[i >>> 5] &= ~(1 << (i & 31)); }
	get(i) { return (this.words[i >>> 5] >>> (i & 31)) & 1; }
	and(other) {
		for (let i = 0; i < this.words.length; i++) this.words[i] &= other.words[i];
		return this;
	}
	anded(other) { return this.clone().and(other); }
	popcount() {
		let n = 0;
		for (let i = 0; i < this.words.length; i++) {
			let w = this.words[i];
			w -= (w >>> 1) & 0x55555555;
			w = (w & 0x33333333) + ((w >>> 2) & 0x33333333);
			w = (w + (w >>> 4)) & 0x0F0F0F0F;
			n += (w * 0x01010101) >>> 24;
		}
		return n;
	}
	isEmpty() {
		for (let i = 0; i < this.words.length; i++) if (this.words[i] !== 0) return false;
		return true;
	}
	firstSet() {
		for (let i = 0; i < this.words.length; i++) {
			const w = this.words[i];
			if (w) return i * 32 + (31 - Math.clz32(w & -w));
		}
		return -1;
	}
	*indices() {
		for (let i = 0; i < this.words.length; i++) {
			let w = this.words[i];
			while (w) {
				const bit = w & -w;
				yield i * 32 + (31 - Math.clz32(bit));
				w ^= bit;
			}
		}
	}
	equals(o) {
		if (o.size !== this.size) return false;
		for (let i = 0; i < this.words.length; i++) if (this.words[i] !== o.words[i]) return false;
		return true;
	}
}

module.exports = { BitSet };
