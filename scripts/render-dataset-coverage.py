"""Render bilingual README coverage figures; requires matplotlib and a CJK font for Chinese."""
from pathlib import Path
import json
import os
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
from matplotlib.font_manager import FontProperties, findfont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'docs/assets'
DATA = json.loads((OUT / 'dataset-coverage.json').read_text())
COLORS = ['#4e719f', '#547d92', '#577c7a', '#6d819d', '#777598', '#538b86',
          '#aa8050', '#9b745f', '#92834b', '#a56c7d', '#688d72', '#657f9f']
plt.rcParams['svg.fonttype'] = 'path'


def chinese_font():
    explicit = os.environ.get('EVALDOCK_CJK_FONT')
    if explicit:
        return FontProperties(fname=explicit)
    for name in ['Arial Unicode MS', 'Noto Sans CJK SC', 'Microsoft YaHei', 'PingFang SC']:
        try:
            return FontProperties(fname=findfont(name, fallback_to_default=False))
        except ValueError:
            pass
    raise RuntimeError('Set EVALDOCK_CJK_FONT to a Chinese font file.')


def draw(lang):
    zh = lang == 'zh'
    cjk = chinese_font() if zh else None
    fig = plt.figure(figsize=(32.8, 30.9), facecolor='white')
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set(xlim=(0, 3280), ylim=(3090, 0)); ax.axis('off')
    texts = []

    def text(x, y, value, size=18, color='#303943', bold=False, right=False):
        font = cjk if zh and any(ord(c) > 1000 for c in value) else FontProperties(family='DejaVu Sans', weight='bold' if bold else 'normal')
        item = ax.text(x, y, value, fontsize=size, fontproperties=font, color=color,
                       ha='right' if right else 'left', va='center')
        texts.append(item)
        return item

    text(32, 48, 'EvalDock 数据集覆盖' if zh else 'EvalDock dataset coverage', 31, bold=True)
    text(3248, 48, '144 个条目 · 1,658 道题' if zh else '144 entries · 1,658 cases', 21, right=True)
    for section_index, section in enumerate(DATA['sections']):
        base = 100 + section_index * 1470
        ax.add_patch(Rectangle((30, base), 3220, 84, facecolor='#263e50', edgecolor='none'))
        text(57, base + 42, f"0{section_index + 1}  {section['name_zh' if zh else 'name_en']}", 27, 'white', True)
        for j, category in enumerate(section['categories']):
            x = 30 + (j % 4) * 811; y = base + 102 + (j // 4) * 450
            w = 787; color = COLORS[j]
            rgb = [int(color[k:k+2], 16) / 255 for k in (1, 3, 5)]
            ax.add_patch(Rectangle((x, y), w, 430, facecolor=tuple(.09 * v + .91 for v in rgb), edgecolor='none'))
            title = category['name_zh' if zh else 'name_en']
            text(x + 24, y + 35, title, 19 if len(title) > 29 else 21, color, True)
            entries, cases = category['entry_count'], category['cases']
            text(x + 24, y + 74, f'{entries} 条目 · {cases:,} 题' if zh else f'{entries} entries · {cases:,} cases', 16, color)
            ax.plot([x + 24, x + w - 24], [y + 98, y + 98], color=color, alpha=.2, lw=1)
            series = sorted(category['series'].items(), key=lambda item: (-item[1], item[0]))
            shown = series if len(series) <= 6 else series[:5] + [(f'其余 {len(series)-5} 个系列' if zh else f'Other {len(series)-5} series', sum(n for _, n in series[5:]))]
            for k, (label, count) in enumerate(shown):
                yy = y + 137 + k * 48
                other = label.startswith(('其余', 'Other '))
                if not other:
                    ax.scatter([x + 43], [yy], s=count * 1.25 + 9, color=color, alpha=.73, edgecolors='white', lw=.5)
                star = label in DATA['highlighted']
                if star:
                    ax.scatter([x + 79], [yy], s=120, marker='*', color='#be8b37', edgecolors='none')
                text(x + 103, yy, label, 16, '#303943' if star else '#586572', star)
                text(x + w - 26, yy, str(count), 17, color, True, True)
    text(35, 3060, '★ 代表性基准 · 分类交叉，题量不可相加' if zh else '★ Selected benchmarks · Categories overlap; counts are not additive.', 16, '#677580')
    fig.canvas.draw()
    # Detect accidentally clipped labels after translations or data updates.
    frame = fig.bbox
    for item in texts:
        box = item.get_window_extent(fig.canvas.get_renderer())
        assert box.x0 >= frame.x0 and box.x1 <= frame.x1, item.get_text()
    stem = 'dataset-coverage.zh-CN' if zh else 'dataset-coverage'
    for ext in ['png', 'svg', 'pdf']:
        path = OUT / f'{stem}.{ext}'
        fig.savefig(path, dpi=150, facecolor='white')
        if ext == 'svg':
            path.write_text('\n'.join(line.rstrip() for line in path.read_text().splitlines()) + '\n')
    fig.savefig(f'/tmp/{stem}-preview.png', dpi=50, facecolor='white')
    plt.close(fig)


if __name__ == '__main__':
    entries = {}
    for section in DATA['sections']:
        for category in section['categories']:
            assert sum(category['series'].values()) == category['cases']
            assert len(category['entries']) == category['entry_count']
            for entry in category['entries']:
                assert entry['id'] not in entries or entries[entry['id']] == entry['cases']
                entries[entry['id']] = entry['cases']
    assert len(entries) == DATA['total_entries'] == 144
    assert sum(entries.values()) == DATA['total_cases'] == 1658
    for language in ['en', 'zh']:
        draw(language)
    print('Rendered EN/ZH PNG, SVG and PDF; verified 144 unique entries / 1,658 cases.')
