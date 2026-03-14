import { getCollection } from 'next/content'

export default async function ProductsPage() {
  const products = await getCollection('products')

  return (
    <div>
      <h1>Products</h1>
      <p id="product-count">Product count: {products.length}</p>
      <ul id="products">
        {products.map((product) => (
          <li key={product._meta.id}>
            <span className="name">{product.name}</span>
            <span className="price"> — ${product.price}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
