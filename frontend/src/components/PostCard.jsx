import { Link } from 'react-router-dom';
import { formatDistanceToNow } from 'date-fns';
import { HiChatBubbleLeft } from 'react-icons/hi2';
import { FiFileText, FiLock } from 'react-icons/fi';

function PostCard({ post }) {
  const timeAgo = formatDistanceToNow(new Date(post.created_at), { addSuffix: true });

  return (
    <Link to={`/post/${post.id}`} className="post-card">
      <div className="post-card-header">
        <div className="post-emoji" style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8' }}>
          <FiFileText size={24} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
            <h2 className="post-card-title">{post.title}</h2>
            {post.is_private && (
              <span className="privacy-badge">
                <FiLock size={11} /> Private
              </span>
            )}
          </div>
          <div className="post-card-meta">
            <span>{post.author}</span>
            <span className="dot" />
            <span>{timeAgo}</span>
          </div>
        </div>
      </div>
      <p className="post-card-preview">{post.content}</p>
      <div className="post-card-footer">
        <div className="comment-badge">
          <HiChatBubbleLeft size={16} />
          <span>{post.comment_count || 0} comments</span>
        </div>
        <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Read more →</span>
      </div>
    </Link>
  );
}

export default PostCard;
