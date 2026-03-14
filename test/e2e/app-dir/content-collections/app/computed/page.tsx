import { getCollection } from 'next/content'

export default async function ComputedPage() {
  const posts = await getCollection('posts')

  return (
    <div>
      <h1>Computed Fields</h1>
      <ul id="reading-times">
        {posts.map((post) => (
          <li key={post._meta.id}>
            <span className="title">{post.title}</span>
            <span className="time"> — {post.readingTime} min read</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
