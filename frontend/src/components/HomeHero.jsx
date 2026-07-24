const TAGS = ["Technical Insights", "Industry Updates", "Professional Network"];

function HomeHero() {
  return (
    <div className="home-header">
      <h1>Welcome to ZYLO</h1>
      <p>
        A very professional platform for publishing your insights, thoughts, and
        technical articles.
      </p>
      <div className="vibe-tags">
        {TAGS.map((tag) => (
          <span key={tag} className="vibe-tag">
            {tag}
          </span>
        ))}
      </div>
    </div>
  );
}

export default HomeHero;
