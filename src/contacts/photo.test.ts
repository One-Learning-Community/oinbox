import { describe, expect, it } from 'vitest';
import { fitSquare } from './photo';

describe('fitSquare', () => {
  it('takes the centred square of a picture', () => {
    expect(fitSquare(600, 400)).toEqual({ sx: 100, sy: 0, side: 400 });
    expect(fitSquare(400, 600)).toEqual({ sx: 0, sy: 100, side: 400 });
    expect(fitSquare(256, 256)).toEqual({ sx: 0, sy: 0, side: 256 });
    expect(fitSquare(101, 50)).toEqual({ sx: 25, sy: 0, side: 50 });
  });
});
