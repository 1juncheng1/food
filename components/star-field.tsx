'use client'
import type { CSSProperties } from 'react'

/**
 * 灵感场星空氛围层（复用组件）
 * 用法：在页面根 div 加 className="inner-page gen-stage" data-mode="inspiration"
 *       然后在容器内第一个子元素放 <StarField />
 */
export default function StarField() {
  return (
    <div className="gen-mode-ambient">
      <i className="gm-star" style={{ top: '22%', left: '78%' }} />
      <i className="gm-star" style={{ top: '34%', left: '36%' }} />
      <i className="gm-star" style={{ top: '12%', left: '58%' }} />
      <i className="gm-star" style={{ top: '46%', left: '8%' }} />
      <i className="gm-star" style={{ top: '28%', left: '92%' }} />
      <i className="gm-star" style={{ top: '58%', left: '68%' }} />
      <i className="gm-star" style={{ top: '66%', left: '24%' }} />
      <i className="gm-star" style={{ top: '74%', left: '84%' }} />
      <i className="gm-star" style={{ top: '18%', left: '46%' }} />
      <i className="gm-star" style={{ top: '52%', left: '50%' }} />
      <i className="gm-star" style={{ top: '84%', left: '10%' }} />
      <i className="gm-star" style={{ top: '80%', left: '58%' }} />
      <i className="gm-star" style={{ top: '40%', left: '88%' }} />
      <i className="gm-star" style={{ top: '90%', left: '34%' }} />
      <i className="gm-meteor" style={{ '--m-top': '-4%', '--m-left': '22%', '--dur': '7s', '--delay': '-2s', '--dx': '-260px', '--dy': '380px', '--len': '90px' } as CSSProperties} />
      <i className="gm-meteor" style={{ '--m-top': '-2%', '--m-left': '66%', '--dur': '9s', '--delay': '-6s', '--dx': '-300px', '--dy': '430px', '--len': '110px' } as CSSProperties} />
      <i className="gm-meteor" style={{ '--m-top': '4%', '--m-left': '92%', '--dur': '8s', '--delay': '-4s', '--dx': '-240px', '--dy': '350px', '--len': '80px' } as CSSProperties} />
    </div>
  )
}
