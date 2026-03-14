import { notFound } from 'next/navigation'
import { getCollection, getEntry } from 'next/content'

export async function generateStaticParams() {
  const posts = await getCollection('posts')
  return posts.map((post) => ({ slug: post._meta.id }))
}

export default async function PostPage({
  params,
}: {
  params: Promise<{ slug: string }>
}) {
  const { slug } = await params
  const post = await getEntry('posts', slug)
  if (!post) notFound()

  return (
    <article>
      <h1 id="title">{post.title}</h1>
      <p id="date">{post.date}</p>
      <div id="body">{post.body}</div>
    </article>
  )
}
