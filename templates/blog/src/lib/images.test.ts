import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeImage, publicPath, renderImg } from './images.ts';
import { png, useProject } from './test-helpers.ts';

describe('describeImage', () => {
  const project = useProject();
  const root = () => join(project.root, 'content');
  const at = (path: string) => join(root(), path);

  it('reads the real size and offers no srcset without variants', () => {
    project.write('content/blog/a/pic.png', png(120, 60));
    expect(describeImage(at('blog/a/pic.png'), root())).toEqual({ src: '/blog/a/pic.png', width: 120, height: 60 });
  });

  it('builds a srcset from -<width>w copies, smallest first, and includes the original', () => {
    project.write('content/pic.png', png(1200, 600));
    project.write('content/pic-960w.png', png(960, 480));
    project.write('content/pic-480w.png', png(480, 240));
    const info = describeImage(at('pic.png'), root());
    expect(info.srcset).toBe('/pic-480w.png 480w, /pic-960w.png 960w, /pic.png 1200w');
  });

  it('accepts a copy whose rounded height is off by a pixel', () => {
    project.write('content/pic.png', png(1000, 667));
    project.write('content/pic-500w.png', png(500, 334));
    expect(describeImage(at('pic.png'), root()).srcset).toContain('500w');
  });

  it('ignores files that only look similar', () => {
    project.write('content/pic.png', png(100, 50));
    project.write('content/pic-copy.png', png(10, 10));
    project.write('content/other-50w.png', png(50, 25));
    project.write('content/pic-50w.jpg', png(50, 25));
    expect(describeImage(at('pic.png'), root()).srcset).toBeUndefined();
  });

  it('fails when a copy is not the width its name says', () => {
    project.write('content/pic.png', png(1000, 500));
    project.write('content/pic-480w.png', png(500, 250));
    expect(() => describeImage(at('pic.png'), root())).toThrow(/pic-480w\.png: the name says 480w but the image is 500px wide/);
  });

  it('fails when a copy was cropped instead of resized', () => {
    project.write('content/pic.png', png(1000, 500));
    project.write('content/pic-480w.png', png(480, 480));
    expect(() => describeImage(at('pic.png'), root())).toThrow(/does not have the same shape/);
  });

  it('names the file that cannot be read', () => {
    project.write('content/broken.png', 'this is not an image');
    expect(() => describeImage(at('broken.png'), root())).toThrow(/content\/broken\.png: cannot read the image size/);
  });

  it('escapes regex characters in the file name', () => {
    project.write('content/a+b (1).png', png(100, 50));
    project.write('content/a+b (1)-50w.png', png(50, 25));
    expect(describeImage(at('a+b (1).png'), root()).srcset).toBe('/a%2Bb%20(1)-50w.png 50w, /a%2Bb%20(1).png 100w');
  });
});

describe('publicPath', () => {
  it('encodes each segment but keeps the slashes', () => {
    expect(publicPath('blog/my post/a&b.png')).toBe('/blog/my%20post/a%26b.png');
  });
});

describe('renderImg', () => {
  const info = { src: '/a.png', width: 100, height: 50 };

  it('writes dimensions and lazy loading by default', () => {
    expect(renderImg(info, 'A "quoted" <alt>')).toBe(
      '<img src="/a.png" alt="A &quot;quoted&quot; &lt;alt&gt;" width="100" height="50" loading="lazy" decoding="async">',
    );
  });

  it('marks an above-the-fold image high priority and not lazy', () => {
    const html = renderImg(info, '', { eager: true });
    expect(html).toContain('fetchpriority="high"');
    expect(html).not.toContain('loading="lazy"');
  });

  it('adds sizes only when there is a srcset', () => {
    expect(renderImg(info, '')).not.toContain('sizes=');
    const html = renderImg({ ...info, srcset: '/a-50w.png 50w, /a.png 100w' }, '');
    expect(html).toContain('srcset="/a-50w.png 50w, /a.png 100w"');
    expect(html).toContain('sizes="');
  });
});
