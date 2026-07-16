import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { createPost } from '../api';
import { HiArrowLeft } from 'react-icons/hi2';
import { FiGlobe, FiLock } from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';
import toast from 'react-hot-toast';

function CreatePost() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [isPrivate, setIsPrivate] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Redirect to login if not authenticated
  if (!user) {
    return (
      <div className="empty-state">
        <FiLock size={48} color="#94a3b8" style={{ marginBottom: '1rem' }} />
        <h3>Sign in to create a post</h3>
        <p>You need to be signed in to publish articles on ZYLO.</p>
        <Link to="/login" className="btn btn-primary">Sign In</Link>
      </div>
    );
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) {
      toast.error('Title and content are required.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await createPost({
        title: title.trim(),
        content: content.trim(),
        author: user.username,
        is_private: isPrivate,
      });
      toast.success('Post created successfully');
      navigate(`/post/${res.data.id}`);
    } catch (err) {
      toast.error('Failed to create post');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="form-page">
      <Link to="/" className="post-detail-back">
        <HiArrowLeft size={16} /> Back to feed
      </Link>
      <h1>Publish a New Article</h1>

      <form className="form-card" onSubmit={handleSubmit}>
        <div className="form-group">
          <label htmlFor="title">Title</label>
          <input
            id="title"
            type="text"
            placeholder="Enter article title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={255}
          />
        </div>

        <div className="form-group">
          <label htmlFor="content">Content</label>
          <textarea
            id="content"
            placeholder="Write your article content here..."
            value={content}
            onChange={(e) => setContent(e.target.value)}
          />
        </div>

        <div className="form-group">
          <label>Visibility</label>
          <div className="visibility-toggle">
            <button
              type="button"
              className={`visibility-option ${!isPrivate ? 'active' : ''}`}
              onClick={() => setIsPrivate(false)}
            >
              <FiGlobe size={16} />
              Public
              <span className="visibility-desc">Visible to everyone</span>
            </button>
            <button
              type="button"
              className={`visibility-option ${isPrivate ? 'active' : ''}`}
              onClick={() => setIsPrivate(true)}
            >
              <FiLock size={16} />
              Private
              <span className="visibility-desc">Only visible to you</span>
            </button>
          </div>
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={submitting}>
            {submitting ? 'Publishing...' : 'Publish'}
          </button>
          <Link to="/" className="btn btn-secondary">
            Cancel
          </Link>
        </div>
      </form>
    </div>
  );
}

export default CreatePost;
