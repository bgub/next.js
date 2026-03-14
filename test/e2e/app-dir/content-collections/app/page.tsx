import Link from 'next/link'
import { getCollection } from 'next/content'

export default async function Page() {
  const posts = await getCollection('posts')

  return (
    <div>
      <h1>Posts</h1>
      <p id="count">Post count: {posts.length}</p>
      <ul id="posts">
        {posts.map((post) => (
          <li key={post._meta.id}>
            <Link href={`/posts/${post._meta.id}`}>{post.title}</Link>
            <span className="date"> — {post.date}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
