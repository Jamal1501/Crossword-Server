function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = Math.random() * 16 | 0,
      v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

class SwipeDetector {
    constructor(element, onSwipe) {
        this.touchstartX = 0;
        this.touchendX = 0;
        this.threshold = 50; // minimum distance for a swipe
        
        element.addEventListener('touchstart', e => {
            this.touchstartX = e.changedTouches[0].screenX;
        });
        
        element.addEventListener('touchend', e => {
            this.touchendX = e.changedTouches[0].screenX;
            this.handleSwipe(onSwipe);
        });
    }

    handleSwipe(callback) {
        const diff = this.touchstartX - this.touchendX;
        if (Math.abs(diff) > this.threshold) {
            if (diff > 0) {
                callback('left');
            } else {
                callback('right');
            }
        }
    }
}


class CrosswordEditor {
    constructor() {
        this.currentProduct = null;
        this.designSpecs = {
            size: '100%',
            top: '0px',
            left: '0px'
        };
    }

async openEditor(variantId, productImage, productTitle, crosswordImage, price) {
    console.log('Opening editor with:', { variantId, productImage, productTitle, crosswordImage, price });
    
    const existingModal = document.querySelector('.editor-modal');
    if (existingModal) {
        existingModal.remove();
    }

    try {
        // Get the crossword image from parameters or localStorage
        const finalCrosswordImage = crosswordImage || localStorage.getItem('lastSavedCrosswordImage');
        
        if (!finalCrosswordImage) {
            this.showFeedback("No crossword image found. Please generate and save a crossword first.", true);
            return;
        }

        // Default print area specifications
        const defaultPrintArea = {
            width: 300,
            height: 300,
            top: 100,
            left: 100
        };

        const editorModal = document.createElement('div');
        editorModal.className = 'editor-modal';
        editorModal.innerHTML = `
            <div class="editor-content">
                <div class="editor-header">
                    <h2>Customize Your ${productTitle}</h2>
                    <p class="price">$${price}</p>
                </div>
                
                <div class="editor-layout">
                    <div class="preview-area">
                        <div class="product-preview" id="preview-container">
                            <img src="${productImage}" alt="${productTitle}" class="product-base">
                            <div class="print-area" style="
                                width: ${defaultPrintArea.width}px;
                                height: ${defaultPrintArea.height}px;
                                top: ${defaultPrintArea.top}px;
                                left: ${defaultPrintArea.left}px;
                            ">
                                <img src="${finalCrosswordImage}" alt="Your design" class="design-preview" id="design-preview">
                            </div>
                        </div>
                    </div>

                    <div class="editor-controls">
                        <div class="control-group">
                            <label>Size</label>
                            <div class="size-controls">
                                <button onclick="crosswordEditor.adjustDesign('size', 'decrease')" class="control-btn">-</button>
                                <button onclick="crosswordEditor.adjustDesign('size', 'increase')" class="control-btn">+</button>
                            </div>
                        </div>

                        <div class="control-group">
                            <label>Position</label>
                            <div class="position-controls">
                                <button onclick="crosswordEditor.adjustDesign('position', 'up')" class="control-btn">↑</button>
                                <button onclick="crosswordEditor.adjustDesign('position', 'down')" class="control-btn">↓</button>
                                <button onclick="crosswordEditor.adjustDesign('position', 'left')" class="control-btn">←</button>
                                <button onclick="crosswordEditor.adjustDesign('position', 'right')" class="control-btn">→</button>
                            </div>
                        </div>

                        <button onclick="crosswordEditor.addToCart('${variantId}', '${finalCrosswordImage}')" class="add-to-cart-btn">
                            Add to Cart
                        </button>
                        <button onclick="crosswordEditor.closeEditor()" class="back-button">
                            Back to Products
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(editorModal);
        
        this.currentProduct = {
            variantId,
            productImage,
            productTitle,
            crosswordImage: finalCrosswordImage,
            price,
            printArea: defaultPrintArea
        };

    } catch (error) {
        console.error('Error loading editor:', error);
        this.showFeedback("Failed to load editor", true);
    }
}

    adjustDesign(type, action) {
        const design = document.getElementById('design-preview');
        if (!design) return;

        switch(type) {
            case 'size':
                const currentSize = parseFloat(design.style.width || '100');
                const newSize = action === 'increase' ? currentSize * 1.1 : currentSize * 0.9;
                design.style.width = `${newSize}%`;
                this.designSpecs.size = `${newSize}%`;
                break;

            case 'position':
                const currentTop = parseInt(design.style.top || '0');
                const currentLeft = parseInt(design.style.left || '0');
                const step = 10;

                switch(action) {
                    case 'up':
                        design.style.top = `${currentTop - step}px`;
                        this.designSpecs.top = `${currentTop - step}px`;
                        break;
                    case 'down':
                        design.style.top = `${currentTop + step}px`;
                        this.designSpecs.top = `${currentTop + step}px`;
                        break;
                    case 'left':
                        design.style.left = `${currentLeft - step}px`;
                        this.designSpecs.left = `${currentLeft - step}px`;
                        break;
                    case 'right':
                        design.style.left = `${currentLeft + step}px`;
                        this.designSpecs.left = `${currentLeft + step}px`;
                        break;
                }
                break;
        }
    }

    async addToCart(variantId, imageUrl) {
        try {
            const formData = {
                'items': [{
                    'id': variantId,
                    'quantity': 1,
                    'properties': {
                        '_custom_image': imageUrl,
                        '_design_specs': JSON.stringify(this.designSpecs)
                    }
                }]
            };

            const response = await fetch('/cart/add.js', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(formData)
            });

            const data = await response.json();
            console.log('Cart response:', data);
            this.showFeedback("Added to cart! Redirecting...");
            
            setTimeout(() => {
                window.location.href = '/cart';
            }, 1000);
        } catch (error) {
            console.error('Cart error:', error);
            this.showFeedback("Failed to add to cart. Please try again.", true);
        }
    }

    closeEditor() {
        const editorModal = document.querySelector('.editor-modal');
        if (editorModal) {
            editorModal.remove();
        }
        this.showProductSelection();
    }

async showProductSelection() {
    try {
        // Get the last saved crossword image URL from localStorage or current state
        const crosswordImageUrl = localStorage.getItem('lastSavedCrosswordImage');
        
        if (!crosswordImageUrl) {
            this.showFeedback("No crossword image found. Please generate and save a crossword first.", true);
            return;
        }

        // Store or update the crossword image URL in the current product state
        this.currentProduct = {
            ...this.currentProduct,
            crosswordImage: crosswordImageUrl
        };

        // Use Shopify's products.json endpoint
        const response = await fetch('/products.json');
        const productsData = await response.json();
        
        // Map the products data to our required format
        this.products = productsData.products.map(product => ({
            variantId: product.variants[0].id,
            image: product.images[0]?.src || '',
            title: product.title,
            price: product.variants[0].price
        }));
        
        if (this.products.length === 0) {
            this.showFeedback("No products available", true);
            return;
        }

        // Set up pagination
        this.productsPerPage = window.innerWidth <= 768 ? 1 : 3;
        this.totalPages = Math.ceil(this.products.length / this.productsPerPage);
        this.currentPage = 1;

        // Show the first page of products
        const modal = document.createElement('div');
        modal.className = 'product-modal';
        modal.innerHTML = `
            <div class="modal-content">
                <h2>Select a Product</h2>
                <div class="product-grid">
                    ${this.getProductCardsHTML(1)}
                </div>
                ${this.getPaginationHTML(1)}
                <button onclick="crosswordEditor.closeModal()" class="close-button">Close</button>
            </div>
        `;
        document.body.appendChild(modal);
        
        // Add swipe detection for mobile
        new SwipeDetector(modal.querySelector('.modal-content'), (direction) => {
            if (direction === 'left' && this.currentPage < this.totalPages) {
                this.changePage(this.currentPage + 1);
            } else if (direction === 'right' && this.currentPage > 1) {
                this.changePage(this.currentPage - 1);
            }
        });

    } catch (error) {
        console.error('Error fetching products:', error);
        this.showFeedback("Failed to load products", true);
    }
}

// Helper method to generate product cards HTML
getProductCardsHTML(pageNumber) {
    const startIndex = (pageNumber - 1) * this.productsPerPage;
    const endIndex = startIndex + this.productsPerPage;
    const pageProducts = this.products.slice(startIndex, endIndex);

    return pageProducts.map(product => `
        <div class="product-card" onclick="crosswordEditor.openEditor(
            '${product.variantId}', 
            '${product.image}', 
            '${product.title}', 
            '${this.currentProduct?.crosswordImage}', 
            ${product.price}
        )">
            <img src="${product.image}" alt="${product.title}" class="product-image">
            <h3>${product.title}</h3>
            <p>$${product.price}</p>
            <button class="customize-btn">Customize Design</button>
        </div>
    `).join('');
}

// Helper method to generate pagination HTML
getPaginationHTML(currentPage) {
    return `
        <div class="pagination">
            <button onclick="crosswordEditor.changePage(${currentPage - 1})" 
                    ${currentPage === 1 ? 'disabled' : ''}>
                Previous
            </button>
            <span class="page-number">Page ${currentPage} of ${this.totalPages}</span>
            <button onclick="crosswordEditor.changePage(${currentPage + 1})"
                    ${currentPage === this.totalPages ? 'disabled' : ''}>
                Next
            </button>
        </div>
    `;
}

// Updated changePage method to work with the new structure
changePage(newPage) {
    if (newPage >= 1 && newPage <= this.totalPages) {
        this.currentPage = newPage;
        
        const modalContent = document.querySelector('.product-modal .modal-content');
        if (modalContent) {
            const productGrid = modalContent.querySelector('.product-grid');
            const pagination = modalContent.querySelector('.pagination');
            
            if (productGrid && pagination) {
                productGrid.innerHTML = this.getProductCardsHTML(newPage);
                pagination.outerHTML = this.getPaginationHTML(newPage);
            }
        }
    }
}

    closeModal() {
        const modal = document.querySelector('.product-modal');
        if (modal) {
            modal.remove();
        }
    }

    showFeedback(message, isError = false) {
        const modal = document.getElementById('feedback-modal');
        const feedbackMessage = document.getElementById('feedback-message');
        
        if (!modal || !feedbackMessage) {
            console.error('Feedback modal elements not found');
            alert(message);
            return;
        }

        feedbackMessage.textContent = message;
        feedbackMessage.className = isError ? 'error-message' : 'success-message';
        modal.style.display = 'block';
        
        setTimeout(() => {
            modal.style.display = 'none';
        }, 3000);
    }
}

// Initialize the editor and make it globally available
const crosswordEditor = new CrosswordEditor();
window.crosswordEditor = crosswordEditor;

